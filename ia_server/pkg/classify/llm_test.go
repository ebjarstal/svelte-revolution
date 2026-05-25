package classify

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// stubMistralServer crée un httptest.Server qui se comporte comme Mistral chat
// completions. `respond` est appelé avec le `mistralRequest` parsé et doit retourner
// le statut HTTP + le content brut (string) à mettre dans `choices[0].message.content`.
// Si `responseEnvelope != ""`, le serveur renvoie ce body brut au lieu d'envelopper
// `content` dans la structure Mistral — utile pour tester un envelope cassé.
func stubMistralServer(t *testing.T, respond func(req mistralRequest) (status int, content string, responseEnvelope string)) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if got := r.Header.Get("Authorization"); !strings.HasPrefix(got, "Bearer ") {
			t.Errorf("expected Authorization Bearer header, got %q", got)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("expected Content-Type application/json, got %q", got)
		}

		body, _ := io.ReadAll(r.Body)
		var req mistralRequest
		if err := json.Unmarshal(body, &req); err != nil {
			t.Errorf("invalid request body: %v", err)
		}

		status, content, envelope := respond(req)
		if envelope != "" {
			w.WriteHeader(status)
			io.WriteString(w, envelope)
			return
		}
		resp := mistralResponse{Choices: []mistralChoice{{Message: mistralMessage{Role: "assistant", Content: content}}}}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(resp)
	}))
}

func TestClassifyLLM_HappyPath(t *testing.T) {
	srv := stubMistralServer(t, func(req mistralRequest) (int, string, string) {
		if req.Model != "mistral-small-latest" {
			t.Errorf("expected model mistral-small-latest, got %q", req.Model)
		}
		if req.ResponseFormat.Type != "json_object" {
			t.Errorf("expected response_format json_object, got %q", req.ResponseFormat.Type)
		}
		if len(req.Messages) != 2 || req.Messages[0].Role != "system" || req.Messages[1].Role != "user" {
			t.Errorf("expected [system, user] messages, got %+v", req.Messages)
		}
		// Le user prompt doit citer le texte joueur et la description d'intent.
		if !strings.Contains(req.Messages[1].Content, "reparer le systeme") {
			t.Errorf("user prompt missing player text, got: %s", req.Messages[1].Content)
		}
		if !strings.Contains(req.Messages[1].Content, "SYSTEME") {
			t.Errorf("user prompt missing intent label, got: %s", req.Messages[1].Content)
		}
		return 200, `{"intent":"SYSTEME","confidence":0.87,"rationale":"le joueur veut réparer","classification":""}`, ""
	})
	defer srv.Close()

	intents := []IntentDecl{
		{Label: "SYSTEME", Description: "reparer le systeme"},
		{Label: "COMPRENDRE", Description: "comprendre l'état"},
	}
	res, err := ClassifyLLM(context.Background(), srv.Client(), srv.URL, "mistral-small-latest", "test-key", "reparer le systeme", "ctx", intents)
	if err != nil {
		t.Fatalf("ClassifyLLM: %v", err)
	}
	if res.Intent != "SYSTEME" {
		t.Errorf("expected intent SYSTEME, got %q", res.Intent)
	}
	if res.Confidence < 0.86 || res.Confidence > 0.88 {
		t.Errorf("expected confidence ~0.87, got %f", res.Confidence)
	}
	if res.Classification != "" {
		t.Errorf("expected empty classification, got %q", res.Classification)
	}
}

func TestClassifyLLM_PosesClassificationFor3036(t *testing.T) {
	srv := stubMistralServer(t, func(req mistralRequest) (int, string, string) {
		return 200, `{"intent":"REPONDRE","confidence":0.9,"rationale":"réponse conforme","classification":"CONFORME"}`, ""
	})
	defer srv.Close()

	intents := []IntentDecl{{Label: "REPONDRE", Description: "réponse à un exercice"}}
	res, err := ClassifyLLM(context.Background(), srv.Client(), srv.URL, "mistral-small-latest", "k", "le chien aboie", "classer en CONFORME/NON_CONFORME", intents)
	if err != nil {
		t.Fatalf("ClassifyLLM: %v", err)
	}
	if res.Classification != "CONFORME" {
		t.Errorf("expected classification CONFORME, got %q", res.Classification)
	}
}

func TestClassifyLLM_HTTP401(t *testing.T) {
	srv := stubMistralServer(t, func(req mistralRequest) (int, string, string) {
		return 401, "", `{"error":"invalid api key"}`
	})
	defer srv.Close()

	_, err := ClassifyLLM(context.Background(), srv.Client(), srv.URL, "mistral-small-latest", "wrong-key", "x", "ctx", []IntentDecl{{Label: "X", Description: "x"}})
	if err == nil {
		t.Fatal("expected error on HTTP 401, got nil")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Errorf("expected error mentioning 401, got %v", err)
	}
}

func TestClassifyLLM_HTTP500(t *testing.T) {
	srv := stubMistralServer(t, func(req mistralRequest) (int, string, string) {
		return 500, "", `internal error`
	})
	defer srv.Close()

	_, err := ClassifyLLM(context.Background(), srv.Client(), srv.URL, "mistral-small-latest", "k", "x", "ctx", []IntentDecl{{Label: "X", Description: "x"}})
	if err == nil {
		t.Fatal("expected error on HTTP 500, got nil")
	}
}

func TestClassifyLLM_BrokenContentJSON(t *testing.T) {
	srv := stubMistralServer(t, func(req mistralRequest) (int, string, string) {
		// content n'est pas du JSON valide
		return 200, `not json at all {`, ""
	})
	defer srv.Close()

	_, err := ClassifyLLM(context.Background(), srv.Client(), srv.URL, "mistral-small-latest", "k", "x", "ctx", []IntentDecl{{Label: "X", Description: "x"}})
	if err == nil {
		t.Fatal("expected error on broken content JSON, got nil")
	}
	if !strings.Contains(err.Error(), "decode message content") {
		t.Errorf("expected error mentioning content decode, got %v", err)
	}
}

func TestClassifyLLM_RescuesClassificationFromIntentField(t *testing.T) {
	// Cas observé sur 3036 : Mistral confond intent et classification quand le
	// prompt_ia décrit une taxonomie. Plutôt que d'échouer, on récupère le label
	// vers `Classification` si présent dans la taxonomie connue.
	srv := stubMistralServer(t, func(req mistralRequest) (int, string, string) {
		return 200, `{"intent":"RIEN","confidence":0.95,"rationale":"le joueur ne veut rien ajouter","classification":""}`, ""
	})
	defer srv.Close()

	intents := []IntentDecl{{Label: "ACCEPT", Description: "accepte"}, {Label: "HESITER", Description: "hésite"}}
	res, err := ClassifyLLM(context.Background(), srv.Client(), srv.URL, "mistral-small-latest", "k", "Non.", "ctx avec RIEN/CONFORME/CREATIF/EVEIL", intents)
	if err != nil {
		t.Fatalf("expected rescue, got error: %v", err)
	}
	if res.Intent != "" {
		t.Errorf("expected intent cleared after rescue, got %q", res.Intent)
	}
	if res.Classification != "RIEN" {
		t.Errorf("expected classification=RIEN after rescue, got %q", res.Classification)
	}
}

func TestClassifyLLM_RescueDoesNotOverrideExistingClassification(t *testing.T) {
	srv := stubMistralServer(t, func(req mistralRequest) (int, string, string) {
		// Mistral pose à la fois intent=RIEN (hors liste) ET classification=CONFORME.
		// On préserve la classification déjà posée et on ne fait que vider l'intent.
		return 200, `{"intent":"RIEN","confidence":0.9,"rationale":"r","classification":"CONFORME"}`, ""
	})
	defer srv.Close()

	intents := []IntentDecl{{Label: "ACCEPT", Description: "x"}}
	res, err := ClassifyLLM(context.Background(), srv.Client(), srv.URL, "mistral-small-latest", "k", "Non.", "ctx", intents)
	if err != nil {
		t.Fatalf("ClassifyLLM: %v", err)
	}
	if res.Intent != "" {
		t.Errorf("expected intent cleared, got %q", res.Intent)
	}
	if res.Classification != "CONFORME" {
		t.Errorf("expected classification preserved as CONFORME, got %q", res.Classification)
	}
}

func TestClassifyLLM_RejectsHallucinatedIntent(t *testing.T) {
	srv := stubMistralServer(t, func(req mistralRequest) (int, string, string) {
		// le modèle renvoie un label qui n'est pas dans la liste candidate
		return 200, `{"intent":"FANTAISIE","confidence":0.99,"rationale":"halluciné","classification":""}`, ""
	})
	defer srv.Close()

	intents := []IntentDecl{{Label: "SYSTEME", Description: "x"}, {Label: "COMPRENDRE", Description: "y"}}
	_, err := ClassifyLLM(context.Background(), srv.Client(), srv.URL, "mistral-small-latest", "k", "x", "ctx", intents)
	if err == nil {
		t.Fatal("expected error on hallucinated intent label, got nil")
	}
	if !strings.Contains(err.Error(), "unknown intent") {
		t.Errorf("expected error mentioning unknown intent, got %v", err)
	}
}

func TestClassifyLLM_AcceptsEmptyIntentAsNoMatch(t *testing.T) {
	srv := stubMistralServer(t, func(req mistralRequest) (int, string, string) {
		return 200, `{"intent":"","confidence":0,"rationale":"rien ne match","classification":""}`, ""
	})
	defer srv.Close()

	intents := []IntentDecl{{Label: "SYSTEME", Description: "x"}}
	res, err := ClassifyLLM(context.Background(), srv.Client(), srv.URL, "mistral-small-latest", "k", "blabla", "ctx", intents)
	if err != nil {
		t.Fatalf("expected no error on explicit no-match, got %v", err)
	}
	if res.Intent != "" {
		t.Errorf("expected empty intent, got %q", res.Intent)
	}
	if res.Confidence != 0 {
		t.Errorf("expected 0 confidence, got %f", res.Confidence)
	}
}

func TestClassifyLLM_ContextTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Force le client à expirer avant de répondre.
		time.Sleep(200 * time.Millisecond)
		w.WriteHeader(200)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	_, err := ClassifyLLM(ctx, srv.Client(), srv.URL, "mistral-small-latest", "k", "x", "ctx", []IntentDecl{{Label: "X", Description: "x"}})
	if err == nil {
		t.Fatal("expected timeout error, got nil")
	}
}

func TestClassifyLLM_RejectsEmptyAPIKey(t *testing.T) {
	_, err := ClassifyLLM(context.Background(), nil, "http://example/", "mistral-small-latest", "", "x", "ctx", []IntentDecl{{Label: "X", Description: "x"}})
	if err == nil {
		t.Fatal("expected error on empty apiKey, got nil")
	}
}

func TestClassifyLLM_RejectsEmptyModel(t *testing.T) {
	_, err := ClassifyLLM(context.Background(), nil, "http://example/", "", "k", "x", "ctx", []IntentDecl{{Label: "X", Description: "x"}})
	if err == nil {
		t.Fatal("expected error on empty model, got nil")
	}
}

func TestClassifyLLM_RejectsEmptyIntents(t *testing.T) {
	_, err := ClassifyLLM(context.Background(), nil, "http://example/", "mistral-small-latest", "k", "x", "ctx", []IntentDecl{})
	if err == nil {
		t.Fatal("expected error on empty intents, got nil")
	}
}

func TestClassifyLLM_ClampsConfidenceOutsideRange(t *testing.T) {
	srv := stubMistralServer(t, func(req mistralRequest) (int, string, string) {
		return 200, `{"intent":"X","confidence":1.7,"rationale":"r","classification":""}`, ""
	})
	defer srv.Close()

	res, err := ClassifyLLM(context.Background(), srv.Client(), srv.URL, "mistral-small-latest", "k", "x", "ctx", []IntentDecl{{Label: "X", Description: "x"}})
	if err != nil {
		t.Fatalf("ClassifyLLM: %v", err)
	}
	if res.Confidence != 1.0 {
		t.Errorf("expected clamped confidence 1.0, got %f", res.Confidence)
	}
}
