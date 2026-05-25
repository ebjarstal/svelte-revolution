// Handler POST /api/classify pour le moteur scripted (cf. docs/narrative-engine-design.md §6).
// Payload §6.1. Le serveur Go ne tient PAS d'état pour ce flux : l'état canonique de
// la session vit en BD côté SvelteKit. `session_state` est désérialisé pour exposition
// future à un LLM (Phase 7), mais reste ignoré par le backend word2vec.
//
// Phase 7 : le handler route en interne entre `word2vec` (cosine sim, hermétique) et
// `llm` (Mistral, plus précis sur français + capable de poser `classification` 3036).
// Le switch est transparent pour le client SvelteKit — un seul endpoint, deux backends
// derrière. Si le LLM échoue (key absente, HTTP non-2xx, JSON cassé, timeout), on
// retombe sur word2vec automatiquement avec un log de warning ; si word2vec est lui
// aussi indisponible (model.bin absent), 503 + le client TS dégrade en no-match.

package webservice

import (
	"TestNLP/pkg/classify"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
)

type classifyRequest struct {
	Session      string                 `json:"session"`
	NodePrompt   string                 `json:"node_prompt"`
	Intents      []classify.IntentDecl  `json:"intents"`
	PlayerText   string                 `json:"player_text"`
	SessionState map[string]interface{} `json:"session_state"`
}

func (rsa *ServerAgent) DoClassify(w http.ResponseWriter, r *http.Request) {
	if !rsa.checkMethod("POST", w, r) {
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprintf(w, "read body: %s", err.Error())
		return
	}

	var req classifyRequest
	if err := json.Unmarshal(body, &req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprintf(w, "decode: %s", err.Error())
		return
	}

	if len(req.Intents) == 0 {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, "intents list must be non-empty")
		return
	}

	result, status, errMsg := rsa.classifyWithFallback(r.Context(), req)
	if status != http.StatusOK {
		w.WriteHeader(status)
		fmt.Fprint(w, errMsg)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	serial, _ := json.Marshal(result)
	w.Write(serial)
}

// classifyWithFallback : route entre LLM et word2vec selon `rsa.ClassifyBackend`.
// Si `llm` est demandé et qu'il échoue ou n'est pas configuré, retombe sur word2vec
// avec un warning log. Si les deux sont indisponibles, retourne 503.
//
// Extrait dans une fonction séparée pour la testabilité (httptest stub Mistral).
func (rsa *ServerAgent) classifyWithFallback(ctx context.Context, req classifyRequest) (classify.IntentResult, int, string) {
	if rsa.ClassifyBackend == "llm" {
		if rsa.MistralAPIKey == "" {
			log.Printf("[Warning] CLASSIFY_BACKEND=llm but MISTRAL_API_KEY is empty, falling back to word2vec for this request")
		} else {
			ctxLLM, cancel := context.WithTimeout(ctx, LLMHTTPTimeout)
			defer cancel()

			res, err := classify.ClassifyLLM(
				ctxLLM,
				rsa.HTTPClient,
				rsa.MistralAPIURL,
				rsa.MistralModel,
				rsa.MistralAPIKey,
				req.PlayerText,
				req.NodePrompt,
				req.Intents,
			)
			if err == nil {
				return res, http.StatusOK, ""
			}
			log.Printf("[Warning] LLM classify failed (%v), falling back to word2vec", err)
		}
	}

	// Path word2vec (par défaut OU fallback depuis LLM).
	if rsa.ClassifyModel == nil {
		return classify.IntentResult{}, http.StatusServiceUnavailable, "no classification backend available (LLM down or unconfigured, word2vec model not loaded)"
	}
	res, err := classify.ClassifyIntent(rsa.ClassifyModel, rsa.ClassifyDict, req.PlayerText, req.Intents)
	if err != nil {
		return classify.IntentResult{}, http.StatusInternalServerError, fmt.Sprintf("classify: %s", err.Error())
	}
	return res, http.StatusOK, ""
}
