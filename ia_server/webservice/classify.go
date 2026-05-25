// Handler POST /api/classify pour le moteur scripted (cf. docs/narrative-engine-design.md §6).
// Payload §6.1. Le serveur Go ne tient PAS d'état pour ce flux : l'état canonique de
// la session vit en BD côté SvelteKit. `session_state` est désérialisé pour exposition
// future à un LLM (Phase 7), mais ignoré par le backend word2vec.

package webservice

import (
	"TestNLP/pkg/classify"
	"encoding/json"
	"fmt"
	"io"
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

	// Modèle word2vec non chargé (fichier `resources/model.bin` absent au boot) : on
	// répond 503 plutôt que 500 — le client TS interprète tout non-2xx comme un
	// fallback no-match (`{intent:'',confidence:0}`), donc le scénario continue.
	if rsa.ClassifyModel == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprint(w, "word2vec model not loaded on this server")
		return
	}

	result, err := classify.ClassifyIntent(rsa.ClassifyModel, rsa.ClassifyDict, req.PlayerText, req.Intents)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, "classify: %s", err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	serial, _ := json.Marshal(result)
	w.Write(serial)
}
