// Client HTTP Mistral pur pour /api/classify (cf. docs/narrative-engine-design.md
// §12 Phase 7). Sans état, sans dépendance externe — utilise net/http stdlib pour
// rester compatible avec la consigne « pas de SDK Go officiel ; appel REST direct ».
//
// Le contrat OpenAI-compatible de Mistral (https://api.mistral.ai/v1/chat/completions)
// expose un champ `response_format: {"type": "json_object"}` qui force un JSON
// parseable dans `choices[0].message.content`. On l'utilise pour éviter le post-
// processing markdown.

package classify

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// MistralEndpoint : URL canonique de l'API Mistral chat completions. Surchargeable
// par le caller (et c'est exactement ce que font les tests via httptest).
const MistralEndpoint = "https://api.mistral.ai/v1/chat/completions"

// Format de réponse attendu du LLM (parsé depuis `choices[0].message.content`).
type llmIntentJSON struct {
	Intent         string  `json:"intent"`
	Confidence     float32 `json:"confidence"`
	Classification string  `json:"classification"`
	Rationale      string  `json:"rationale"`
}

type mistralMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type mistralRespFormat struct {
	Type string `json:"type"`
}

type mistralRequest struct {
	Model          string            `json:"model"`
	Messages       []mistralMessage  `json:"messages"`
	ResponseFormat mistralRespFormat `json:"response_format"`
	Temperature    float32           `json:"temperature"`
}

type mistralChoice struct {
	Message mistralMessage `json:"message"`
}

type mistralResponse struct {
	Choices []mistralChoice `json:"choices"`
}

// ClassifyLLM appelle Mistral pour classifier `playerText` dans `intents`. Sans
// état, ré-entrant. Le `ctx` permet aux callers d'imposer un timeout (le critère
// §12 Phase 7 vise P95 < 2s).
//
// `apiURL` : URL complète du endpoint chat completions. En prod = `MistralEndpoint` ;
// les tests injectent une URL `httptest`.
// `model`  : nom du modèle (ex. `mistral-small-latest`). Vide ⇒ erreur.
// `apiKey` : token Bearer. Vide ⇒ erreur (le handler caller doit fallback word2vec).
//
// Retour : un `IntentResult` avec potentiellement `Classification` non-vide si le
// `promptIa` invoque une taxonomie (ex. 3036 CONFORME/NON_CONFORME). `Alternatives`
// reste vide — le LLM ne les remplit pas dans ce design (les choix secondaires sont
// gérés via re-prompt manuel hors-scope).
//
// Toute erreur réseau, HTTP non-2xx, JSON invalide ⇒ `error` ; le caller décide du
// fallback. On NE renvoie PAS de `IntentResult` partiel sur erreur.
func ClassifyLLM(
	ctx context.Context,
	httpClient *http.Client,
	apiURL string,
	model string,
	apiKey string,
	playerText string,
	promptIa string,
	intents []IntentDecl,
) (IntentResult, error) {
	if apiKey == "" {
		return IntentResult{}, fmt.Errorf("classify-llm: apiKey is empty")
	}
	if model == "" {
		return IntentResult{}, fmt.Errorf("classify-llm: model is empty")
	}
	if apiURL == "" {
		return IntentResult{}, fmt.Errorf("classify-llm: apiURL is empty")
	}
	if len(intents) == 0 {
		return IntentResult{}, fmt.Errorf("classify-llm: empty intents list")
	}
	if httpClient == nil {
		httpClient = http.DefaultClient
	}

	systemPrompt := buildSystemPrompt()
	userPrompt := buildUserPrompt(promptIa, intents, playerText)

	body := mistralRequest{
		Model: model,
		Messages: []mistralMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userPrompt},
		},
		ResponseFormat: mistralRespFormat{Type: "json_object"},
		Temperature:    0,
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return IntentResult{}, fmt.Errorf("classify-llm: marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL, bytes.NewReader(payload))
	if err != nil {
		return IntentResult{}, fmt.Errorf("classify-llm: new request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := httpClient.Do(req)
	if err != nil {
		return IntentResult{}, fmt.Errorf("classify-llm: do request: %w", err)
	}
	defer resp.Body.Close()

	rawResp, err := io.ReadAll(resp.Body)
	if err != nil {
		return IntentResult{}, fmt.Errorf("classify-llm: read response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return IntentResult{}, fmt.Errorf("classify-llm: HTTP %d: %s", resp.StatusCode, truncate(string(rawResp), 200))
	}

	var mistralResp mistralResponse
	if err := json.Unmarshal(rawResp, &mistralResp); err != nil {
		return IntentResult{}, fmt.Errorf("classify-llm: decode response envelope: %w", err)
	}
	if len(mistralResp.Choices) == 0 {
		return IntentResult{}, fmt.Errorf("classify-llm: empty choices in response")
	}
	content := mistralResp.Choices[0].Message.Content

	var parsed llmIntentJSON
	if err := json.Unmarshal([]byte(content), &parsed); err != nil {
		return IntentResult{}, fmt.Errorf("classify-llm: decode message content as JSON: %w (content=%s)", err, truncate(content, 200))
	}

	// Valide que l'intent renvoyé fait partie de la liste demandée — sinon le LLM
	// hallucine un label et le runtime SvelteKit produira un no-match silencieux.
	// On laisse passer "" (signal explicite de no-match), mais pas un label inventé.
	if parsed.Intent != "" && !labelInList(parsed.Intent, intents) {
		return IntentResult{}, fmt.Errorf("classify-llm: model returned unknown intent %q (allowed=%v)", parsed.Intent, labelList(intents))
	}

	conf := clampConfidence(parsed.Confidence)

	return IntentResult{
		Intent:         parsed.Intent,
		Confidence:     conf,
		Classification: strings.TrimSpace(parsed.Classification),
		Rationale:      parsed.Rationale,
		Alternatives:   []Alternative{},
	}, nil
}

func buildSystemPrompt() string {
	return strings.Join([]string{
		"Tu es un classifieur d'intention pour une narration interactive en français.",
		"Tu reçois (a) un contexte d'invocation décrivant le moment du récit, (b) une liste d'intentions candidates avec leur description, (c) le texte écrit par le joueur.",
		"Tu retournes UN OBJET JSON pur (sans markdown) avec les champs :",
		"  \"intent\" : le label EXACT (en majuscules, tel quel) de l'intention la plus pertinente — DOIT figurer dans la liste candidate.",
		"  \"confidence\" : un nombre entre 0.0 et 1.0.",
		"  \"rationale\" : une phrase courte en français expliquant le choix.",
		"  \"classification\" : (optionnel) un label de taxonomie additionnelle si le contexte d'invocation le demande EXPLICITEMENT (ex. CONFORME / NON_CONFORME / CRITIQUE / NON_COOPERATIF / CREATIF / EVEIL / RIEN pour le scénario 3036). Laisse \"\" sinon.",
		"Si aucune intention candidate ne correspond raisonnablement au texte joueur, renvoie {\"intent\":\"\",\"confidence\":0,\"rationale\":\"...\",\"classification\":\"\"}.",
	}, "\n")
}

func buildUserPrompt(promptIa string, intents []IntentDecl, playerText string) string {
	var b strings.Builder
	b.WriteString("CONTEXTE D'INVOCATION:\n")
	if strings.TrimSpace(promptIa) == "" {
		b.WriteString("(aucun contexte spécifique — utilise uniquement les descriptions d'intent)\n")
	} else {
		b.WriteString(promptIa)
		b.WriteString("\n")
	}
	b.WriteString("\nINTENTIONS CANDIDATES:\n")
	for _, it := range intents {
		b.WriteString("- ")
		b.WriteString(it.Label)
		b.WriteString(": ")
		b.WriteString(it.Description)
		b.WriteString("\n")
	}
	b.WriteString("\nTEXTE DU JOUEUR:\n")
	b.WriteString(playerText)
	return b.String()
}

func labelInList(label string, intents []IntentDecl) bool {
	for _, it := range intents {
		if it.Label == label {
			return true
		}
	}
	return false
}

func labelList(intents []IntentDecl) []string {
	out := make([]string, 0, len(intents))
	for _, it := range intents {
		out = append(out, it.Label)
	}
	return out
}

func clampConfidence(c float32) float32 {
	if c < 0 {
		return 0
	}
	if c > 1 {
		return 1
	}
	return c
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}
