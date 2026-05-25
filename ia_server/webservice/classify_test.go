package webservice

import (
	"TestNLP/pkg/classify"
	"TestNLP/word2vec"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// buildTinyW2VModel : duplique le helper word2vec en mémoire de
// pkg/classify/classify_test.go (les helpers `_test.go` ne traversent pas les
// packages). Trois familles orthogonales [1,0,0]/[0,1,0]/[0,0,1] pour des
// argmax non-ambigus.
func buildTinyW2VModel(t *testing.T) *word2vec.Model {
	t.Helper()
	families := map[string][]string{
		"systeme":    {"reparer", "systeme", "navigation", "terminal"},
		"comprendre": {"comprendre", "etat", "passe", "expliquer"},
		"observer":   {"voir", "ecouter", "observer", "regarder"},
	}
	axes := map[string]word2vec.Vector{
		"systeme":    {1, 0, 0},
		"comprendre": {0, 1, 0},
		"observer":   {0, 0, 1},
	}
	vecs := map[string]word2vec.Vector{}
	for fam, words := range families {
		for _, w := range words {
			vecs[w] = axes[fam]
		}
	}
	buf := &bytes.Buffer{}
	fmt.Fprintln(buf, len(vecs), 3)
	for w, v := range vecs {
		fmt.Fprintf(buf, "%s ", w)
		if err := binary.Write(buf, binary.LittleEndian, v); err != nil {
			t.Fatalf("write vector for %q: %v", w, err)
		}
		fmt.Fprintf(buf, "\n")
	}
	m, err := word2vec.FromReader(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatalf("FromReader: %v", err)
	}
	return m
}

// stubMistralForHandler : httptest server qui mime Mistral. `behavior` est appelé
// à chaque requête et contrôle (status, content). Si `envelope != ""`, on renvoie
// le body brut au lieu d'envelopper.
func stubMistralForHandler(t *testing.T, behavior func() (status int, content string, envelope string)) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		status, content, envelope := behavior()
		if envelope != "" {
			w.WriteHeader(status)
			io.WriteString(w, envelope)
			return
		}
		resp := map[string]interface{}{
			"choices": []map[string]interface{}{
				{"message": map[string]string{"role": "assistant", "content": content}},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(resp)
	}))
}

func sampleReq() classifyRequest {
	return classifyRequest{
		Session:    "sess-x",
		NodePrompt: "déclencher si le joueur parle du terminal",
		Intents: []classify.IntentDecl{
			{Label: "SYSTEME", Description: "reparer le systeme la navigation terminal"},
			{Label: "COMPRENDRE", Description: "comprendre l'etat passe"},
		},
		PlayerText:   "je veux reparer le systeme",
		SessionState: map[string]interface{}{},
	}
}

func newAgentForTest(backend string, mistralURL, apiKey string, model *word2vec.Model) *ServerAgent {
	return &ServerAgent{
		ClassifyModel:   model,
		ClassifyDict:    nil,
		ClassifyBackend: backend,
		MistralAPIURL:   mistralURL,
		MistralAPIKey:   apiKey,
		MistralModel:    DefaultMistralModel,
		HTTPClient:      http.DefaultClient,
	}
}

func TestClassifyWithFallback_Word2vecDefault(t *testing.T) {
	model := buildTinyW2VModel(t)
	agent := newAgentForTest("word2vec", "", "", model)

	res, status, msg := agent.classifyWithFallback(context.Background(), sampleReq())
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", status, msg)
	}
	if res.Intent != "SYSTEME" {
		t.Errorf("expected SYSTEME, got %q", res.Intent)
	}
	if res.Classification != "" {
		t.Errorf("expected empty classification on word2vec backend, got %q", res.Classification)
	}
}

func TestClassifyWithFallback_LLMHappyPath(t *testing.T) {
	srv := stubMistralForHandler(t, func() (int, string, string) {
		return 200, `{"intent":"SYSTEME","confidence":0.91,"rationale":"le joueur veut réparer","classification":""}`, ""
	})
	defer srv.Close()

	// Model nil pour prouver qu'on ne fallback PAS sur word2vec dans le happy path.
	agent := newAgentForTest("llm", srv.URL, "test-key", nil)

	res, status, msg := agent.classifyWithFallback(context.Background(), sampleReq())
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", status, msg)
	}
	if res.Intent != "SYSTEME" {
		t.Errorf("expected SYSTEME, got %q", res.Intent)
	}
	if res.Confidence < 0.9 || res.Confidence > 0.92 {
		t.Errorf("expected confidence ~0.91, got %f", res.Confidence)
	}
}

func TestClassifyWithFallback_LLMPosesClassification3036(t *testing.T) {
	srv := stubMistralForHandler(t, func() (int, string, string) {
		return 200, `{"intent":"REPONDRE","confidence":0.95,"rationale":"r","classification":"CONFORME"}`, ""
	})
	defer srv.Close()

	agent := newAgentForTest("llm", srv.URL, "test-key", nil)
	req := classifyRequest{
		NodePrompt: "classer en CONFORME/NON_CONFORME/CRITIQUE/NON_COOPERATIF",
		Intents:    []classify.IntentDecl{{Label: "REPONDRE", Description: "réponse exercice"}},
		PlayerText: "le chien aboie",
	}

	res, status, _ := agent.classifyWithFallback(context.Background(), req)
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d", status)
	}
	if res.Classification != "CONFORME" {
		t.Errorf("expected classification CONFORME (résout dette 3036), got %q", res.Classification)
	}
}

func TestClassifyWithFallback_LLMMissingKeyFallsBackToWord2vec(t *testing.T) {
	model := buildTinyW2VModel(t)
	// Backend llm mais pas d'API key → fallback word2vec.
	agent := newAgentForTest("llm", "http://unused/", "", model)

	res, status, msg := agent.classifyWithFallback(context.Background(), sampleReq())
	if status != http.StatusOK {
		t.Fatalf("expected 200 (word2vec fallback), got %d (%s)", status, msg)
	}
	if res.Intent != "SYSTEME" {
		t.Errorf("expected SYSTEME from word2vec fallback, got %q", res.Intent)
	}
}

func TestClassifyWithFallback_LLMHTTPErrorFallsBackToWord2vec(t *testing.T) {
	srv := stubMistralForHandler(t, func() (int, string, string) {
		return 500, "", "internal error"
	})
	defer srv.Close()

	model := buildTinyW2VModel(t)
	agent := newAgentForTest("llm", srv.URL, "test-key", model)

	res, status, msg := agent.classifyWithFallback(context.Background(), sampleReq())
	if status != http.StatusOK {
		t.Fatalf("expected 200 (word2vec fallback after LLM 500), got %d (%s)", status, msg)
	}
	if res.Intent != "SYSTEME" {
		t.Errorf("expected SYSTEME from word2vec fallback, got %q", res.Intent)
	}
}

func TestClassifyWithFallback_LLMBrokenJSONFallsBackToWord2vec(t *testing.T) {
	srv := stubMistralForHandler(t, func() (int, string, string) {
		return 200, `not json at all {`, ""
	})
	defer srv.Close()

	model := buildTinyW2VModel(t)
	agent := newAgentForTest("llm", srv.URL, "test-key", model)

	res, status, _ := agent.classifyWithFallback(context.Background(), sampleReq())
	if status != http.StatusOK {
		t.Fatalf("expected 200 (word2vec fallback after broken JSON), got %d", status)
	}
	if res.Intent != "SYSTEME" {
		t.Errorf("expected SYSTEME, got %q", res.Intent)
	}
}

func TestClassifyWithFallback_BothBackendsDown503(t *testing.T) {
	srv := stubMistralForHandler(t, func() (int, string, string) {
		return 500, "", "down"
	})
	defer srv.Close()

	// LLM down + word2vec nil → 503.
	agent := newAgentForTest("llm", srv.URL, "test-key", nil)

	_, status, msg := agent.classifyWithFallback(context.Background(), sampleReq())
	if status != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d (%s)", status, msg)
	}
	if !strings.Contains(msg, "no classification backend available") {
		t.Errorf("expected 503 message mentioning unavailability, got %q", msg)
	}
}

func TestClassifyWithFallback_Word2vecBackendStillRespects503(t *testing.T) {
	// Régression Phase 6 : backend par défaut, model nil → 503.
	agent := newAgentForTest("word2vec", "", "", nil)

	_, status, _ := agent.classifyWithFallback(context.Background(), sampleReq())
	if status != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 on word2vec backend with nil model, got %d", status)
	}
}

// Test end-to-end via le handler HTTP (parse body → fallback → sérialise).
func TestDoClassify_LLMHappyPathHTTPRoundTrip(t *testing.T) {
	srv := stubMistralForHandler(t, func() (int, string, string) {
		return 200, `{"intent":"SYSTEME","confidence":0.9,"rationale":"r","classification":""}`, ""
	})
	defer srv.Close()

	agent := newAgentForTest("llm", srv.URL, "test-key", nil)

	bodyBytes, _ := json.Marshal(sampleReq())
	req := httptest.NewRequest(http.MethodPost, "/api/classify", bytes.NewReader(bodyBytes))
	rec := httptest.NewRecorder()

	agent.DoClassify(rec, req)

	if rec.Code != 200 {
		t.Fatalf("expected 200, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	var out classify.IntentResult
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if out.Intent != "SYSTEME" {
		t.Errorf("expected SYSTEME, got %q", out.Intent)
	}
}
