package classify

import (
	"TestNLP/word2vec"
	"bytes"
	"encoding/binary"
	"fmt"
	"testing"
)

// buildModel monte un modèle word2vec en mémoire pour les tests. Les vecteurs sont
// déjà unitaires donc FromReader les laisse intacts après normalisation. Chaque mot
// est rangé dans une « famille » (axe orthogonal) pour que cosine similarity = 1
// entre mots de la même famille, 0 entre familles différentes.
func buildModel(t *testing.T) *word2vec.Model {
	t.Helper()

	families := map[string][]string{
		// Famille SYSTÈME : axe [1,0,0]
		"systeme": {"reparer", "systeme", "navigation", "terminal"},
		// Famille COMPRENDRE : axe [0,1,0]
		"comprendre": {"comprendre", "etat", "passe", "expliquer"},
		// Famille OBSERVER : axe [0,0,1]
		"observer": {"voir", "ecouter", "observer", "regarder"},
	}
	axes := map[string]word2vec.Vector{
		"systeme":    {1, 0, 0},
		"comprendre": {0, 1, 0},
		"observer":   {0, 0, 1},
	}

	vecs := make(map[string]word2vec.Vector)
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

func TestClassifyIntent_ArgmaxOnSystemFamily(t *testing.T) {
	model := buildModel(t)

	intents := []IntentDecl{
		{Label: "SYSTEME", Description: "reparer le systeme la navigation"},
		{Label: "COMPRENDRE", Description: "comprendre etat passe"},
		{Label: "OBSERVER", Description: "voir ecouter"},
	}

	result, err := ClassifyIntent(model, nil, "je veux reparer le systeme", intents)
	if err != nil {
		t.Fatalf("ClassifyIntent: %v", err)
	}
	if result.Intent != "SYSTEME" {
		t.Errorf("expected SYSTEME, got %q (alternatives=%v)", result.Intent, result.Alternatives)
	}
	if result.Confidence <= 0 {
		t.Errorf("expected positive confidence, got %f", result.Confidence)
	}
	if len(result.Alternatives) != 2 {
		t.Errorf("expected 2 alternatives, got %d", len(result.Alternatives))
	}
	// Les alternatives doivent être triées par confidence décroissante.
	for i := 1; i < len(result.Alternatives); i++ {
		if result.Alternatives[i-1].Confidence < result.Alternatives[i].Confidence {
			t.Errorf("alternatives not sorted desc: %v", result.Alternatives)
		}
	}
}

func TestClassifyIntent_ArgmaxOnComprendreFamily(t *testing.T) {
	model := buildModel(t)

	intents := []IntentDecl{
		{Label: "SYSTEME", Description: "reparer terminal"},
		{Label: "COMPRENDRE", Description: "comprendre etat"},
		{Label: "OBSERVER", Description: "voir ecouter"},
	}

	result, err := ClassifyIntent(model, nil, "je veux comprendre ce qui se passe", intents)
	if err != nil {
		t.Fatalf("ClassifyIntent: %v", err)
	}
	if result.Intent != "COMPRENDRE" {
		t.Errorf("expected COMPRENDRE, got %q", result.Intent)
	}
}

func TestClassifyIntent_NoVocabMatch(t *testing.T) {
	model := buildModel(t)

	intents := []IntentDecl{
		{Label: "SYSTEME", Description: "reparer terminal"},
	}

	// Aucun token du texte joueur n'est dans le vocabulaire (« je », « veux »,
	// « beaucoup » : drops/stopwords ou hors-vocab).
	result, err := ClassifyIntent(model, nil, "xyz qwerty foobar", intents)
	if err != nil {
		t.Fatalf("ClassifyIntent: %v", err)
	}
	if result.Intent != "" {
		t.Errorf("expected empty intent on no-match, got %q", result.Intent)
	}
	if result.Confidence != 0 {
		t.Errorf("expected 0 confidence on no-match, got %f", result.Confidence)
	}
}

func TestClassifyIntent_EmptyIntents(t *testing.T) {
	model := buildModel(t)
	_, err := ClassifyIntent(model, nil, "reparer", []IntentDecl{})
	if err == nil {
		t.Errorf("expected error on empty intents")
	}
}

func TestClassifyIntent_NilModel(t *testing.T) {
	_, err := ClassifyIntent(nil, nil, "reparer", []IntentDecl{{Label: "X", Description: "x"}})
	if err == nil {
		t.Errorf("expected error on nil model")
	}
}

func TestClassifyIntent_IntentWithoutInVocabDescription(t *testing.T) {
	model := buildModel(t)
	// Une description hors-vocab doit donner confidence 0 sans crasher.
	intents := []IntentDecl{
		{Label: "VIDE", Description: "xyz qwerty"},
		{Label: "SYSTEME", Description: "reparer terminal"},
	}
	result, err := ClassifyIntent(model, nil, "reparer", intents)
	if err != nil {
		t.Fatalf("ClassifyIntent: %v", err)
	}
	if result.Intent != "SYSTEME" {
		t.Errorf("expected SYSTEME (only intent with in-vocab desc), got %q", result.Intent)
	}
}

func TestTokenize_DropsStopWordsAndShortTokens(t *testing.T) {
	tokens := tokenize("Je veux comprendre l'état du système.")
	// "je", "l", "du" sont stop-words ; "veux" et "veux" ne sont pas dans le set par défaut.
	// On vérifie au moins que "comprendre", "système" (sans diacritique perdu : regex inclut à-ÿ) passent
	// et que les stop-words bien connus sont retirés.
	found := map[string]bool{}
	for _, t := range tokens {
		found[t] = true
	}
	if found["je"] {
		t.Errorf("stop-word 'je' should be removed, got tokens=%v", tokens)
	}
	if !found["comprendre"] {
		t.Errorf("expected 'comprendre' in tokens, got %v", tokens)
	}
}
