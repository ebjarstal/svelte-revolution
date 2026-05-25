// Package classify implémente l'endpoint d'intention pour le moteur scripted
// (cf. docs/narrative-engine-design.md §6). Donne une fonction pure d'intent
// classification par cosine similarity word2vec, indépendante de toute Session
// (l'état canonique du moteur vit en BD côté SvelteKit ; le serveur Go ne tient
// pas d'état pour ce flux).
package classify

import (
	"TestNLP/pkg/dictionnary"
	"TestNLP/pkg/libs"
	"TestNLP/word2vec"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// IntentDecl : déclaration d'un intent côté payload (§6.1).
type IntentDecl struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}

// Alternative : intent secondaire renvoyé pour debug/UI éventuelle (§6.1).
type Alternative struct {
	Label      string  `json:"label"`
	Confidence float32 `json:"confidence"`
}

// IntentResult : payload OUT (§6.1).
type IntentResult struct {
	Intent       string        `json:"intent"`
	Confidence   float32       `json:"confidence"`
	Rationale    string        `json:"rationale"`
	Alternatives []Alternative `json:"alternatives"`
}

// ClassifyIntent calcule la similarité cosinus entre l'embedding moyenné du texte joueur
// et l'embedding moyenné de chaque description d'intent, puis retourne l'argmax. Si
// `playerText` ne contient aucun mot connu du modèle, retourne `{Intent:"", Confidence:0}`
// — le runtime SvelteKit interprétera ça comme un no-match (fallback).
//
// `dict` peut être nil : dans ce cas l'auto-correction est désactivée. Le modèle doit
// être non-nil ; le caller (handler HTTP) garantit cette précondition.
func ClassifyIntent(
	model *word2vec.Model,
	dict *dictionnary.Dictionnary,
	playerText string,
	intents []IntentDecl,
) (IntentResult, error) {
	if model == nil {
		return IntentResult{}, fmt.Errorf("classify: word2vec model is nil")
	}
	if len(intents) == 0 {
		return IntentResult{}, fmt.Errorf("classify: empty intents list")
	}

	playerExpr := buildExpr(model, dict, playerText)
	if len(playerExpr) == 0 {
		// Aucun token in-vocab : pas de signal exploitable.
		return IntentResult{
			Intent:       "",
			Confidence:   0,
			Rationale:    "aucun mot du texte joueur n'est dans le vocabulaire word2vec",
			Alternatives: []Alternative{},
		}, nil
	}

	scored := make([]Alternative, 0, len(intents))
	for _, intent := range intents {
		intentExpr := buildExpr(model, dict, intent.Description)
		if len(intentExpr) == 0 {
			scored = append(scored, Alternative{Label: intent.Label, Confidence: 0})
			continue
		}
		sim, err := model.Cos(playerExpr, intentExpr)
		if err != nil {
			// L'Expr a des tokens mais aucun n'est trouvable au moment de l'Eval : on
			// traite comme 0 plutôt que de faire échouer l'ensemble du classify.
			scored = append(scored, Alternative{Label: intent.Label, Confidence: 0})
			continue
		}
		scored = append(scored, Alternative{Label: intent.Label, Confidence: sim})
	}

	sort.SliceStable(scored, func(i, j int) bool {
		return scored[i].Confidence > scored[j].Confidence
	})

	best := scored[0]
	alts := scored[1:]
	if alts == nil {
		alts = []Alternative{}
	}

	return IntentResult{
		Intent:       best.Label,
		Confidence:   best.Confidence,
		Rationale:    fmt.Sprintf("cosine similarity %.3f vs description de l'intent", best.Confidence),
		Alternatives: alts,
	}, nil
}

// buildExpr : tokenise → lowercase → strip non-alphanumériques → drop stop-words →
// (optionnel) auto-corrige via dictionnaire → ajoute à un word2vec.Expr. Les tokens
// inconnus du modèle ne polluent pas le calcul cosine : `Cos` ignore les entrées non
// trouvées (via NotFoundError) seulement si AUCUN n'est trouvé — sinon il propage. On
// pré-filtre donc strictement aux tokens présents dans le modèle.
func buildExpr(model *word2vec.Model, dict *dictionnary.Dictionnary, text string) word2vec.Expr {
	expr := word2vec.Expr{}
	for _, token := range tokenize(text) {
		final := token
		if dict != nil && !dict.IsInDict(token) {
			// AutoCorrect retombe sur le mot le plus proche en distance de Levenshtein,
			// utile sur fautes de frappe joueur. Si toujours hors-vocab après correction,
			// IsInDict refusera de l'ajouter.
			final = dict.AutoCorrect(token)
		}
		if !modelHas(model, final) {
			continue
		}
		expr.Add(1, final)
	}
	return expr
}

// modelHas teste l'appartenance au vocabulaire sans dépendre d'un accès direct au map
// privé `words` du modèle. Map([]string{w}) retourne une map vide si `w` est absent.
func modelHas(model *word2vec.Model, word string) bool {
	if word == "" {
		return false
	}
	return len(model.Map([]string{word})) > 0
}

var tokenSplit = regexp.MustCompile(`[^a-zà-ÿ0-9]+`)

func tokenize(text string) []string {
	lower := strings.ToLower(text)
	raw := tokenSplit.Split(lower, -1)
	out := make([]string, 0, len(raw))
	for _, t := range raw {
		if len(t) < 2 {
			continue
		}
		if libs.StopWordsMap[t] {
			continue
		}
		out = append(out, t)
	}
	return out
}
