# STATUS — 2026-05-25 (post-Phase 6)

## Phase courante
Prêt à démarrer Phase 7 (LLM-backed `/api/classify` — optionnel, cf.
`docs/narrative-engine-design.md` §12).

## Phases livrées
- **Phase 1** — Fixtures YAML `helix-corp.yaml` (1575 lignes, 47 noeuds, 10 preuves,
  4 PNJ, 3 fins) et `3036.yaml` (915 lignes, 5 fins) avec parseur YAML hermétique.
- **Phase 2** — `db/schema.json` étendu (collections `Characters`, `Evidences`,
  `StateAxes` ; champs scripted additifs sur `Scenario`, `Node`, `Session`, `End`),
  Zod schema `scripted-scenario.schema.ts` créé, types TS alignés.
- **Phase 3** — Moteur narratif pur dans `src/lib/narrative/` (types, compile,
  conditions DSL, effects DSL, engine.step, parser YAML, index public hermétique).
- **Phase 3bis** — 6 fixes polish (refines Zod, refus `condition: {}`, ligne
  YamlParseError, unicité `external_id` sur 5 collections, régression cross-module
  `validateReferences`, clamp `actions_left`).
- **Phase 4** — Authoring scripted via `/admin/scenario/import`, batch transactionnel
  PocketBase 0.26, drop `TriggerNodes`, `RUNBOOK.md` + subagent `runbook-keeper`
  introduits comme byproduct.
- **Phase 5** — Runtime scripted serveur + UI joueur. 5 sous-tâches livrées :
  - 5.1 `createScriptedSession()` côté admin + dropdown engine-aware.
  - 5.2 `classifyStub(text, prompt_ia, intents)` hermétique.
  - 5.3 `progressScripted(pb, sessionId, text, classifier)` : bridge PB id ↔ external_id.
  - 5.4 Branche `engine === 'scripted'` dans l'action form `addNode` (helper
    `isScriptedScenario()`).
  - 5.5 `ScriptedPlayer.svelte` : noeud courant + textarea + sidebar + écran de fin.
- **Phase 6** — Endpoint Go `/api/classify` word2vec + bascule via feature flag :
  - `ia_server/pkg/classify/classify.go` : `ClassifyIntent(model, dict, text, intents)`
    pure, cosine similarity argmax + tri des alternatives (6 tests Go unitaires
    avec modèle en mémoire).
  - `ia_server/webservice/classify.go` : handler POST `/api/classify`, payload §6.1.
    Retourne 503 si modèle non chargé (le client TS fallback gracieusement en no-match).
  - `ia_server/webservice/server.go` : `ServerAgent` charge le modèle word2vec
    partagé au boot (path `libs.Word2vecFilePath`), indépendant des Sessions
    censorship. Best-effort : warning + démarrage normal si modèle absent.
  - `src/lib/server/ia/classify-core.ts` : cœur hermétique `createClassifyWord2vec(iaUrl)`.
  - `src/lib/server/ia/classify.ts` : adapter SvelteKit (`$env/dynamic/private`)
    + `pickClassifier()` selector lu par `+page.server.ts`.
  - Feature flag `IA_CLASSIFY_BACKEND=stub|word2vec` (commit dans `.env` commenté).
    Défaut `stub` — Phase 5.2 reste l'implémentation par défaut.
  - `tests/units/narrative/classify-word2vec.test.ts` : 10 tests Vitest (payload
    §6.1, mapping, 6 fallbacks no-match dont fetch throw / 503 / URL absent /
    intents vide / JSON cassé).

## Tests
- `pnpm check` : ✅ 0 errors (3 warnings pré-existants hors scope).
- `pnpm test:narrative` : ✅ **153/153 PASS** (143 → 153 = +10 tests Phase 6).
- `go test ./...` dans `ia_server/` : ✅ pkg/classify 6/6, word2vec 4/4.
- `pnpm test:unit` (suite complète sans cible) : ❌ pré-existant `scenario.test.ts`
  qui importe `$lib/i18n` non résoluble par Vitest. Dette à régler hors Phase 6.

## Critère §12 Phase 6 — validation acceptance manuelle restante
> « Une partie complète Helix jouée avec `IA_CLASSIFY_BACKEND=word2vec` produit
> les mêmes noeuds que le stub sur ≥80% des inputs. »

Pas automatisable en CI : le modèle word2vec (`resources/model.bin`) fait plusieurs
Go et n'est pas versionné. À jouer en local avec :
1. `pnpm run ia` (model.bin présent dans `ia_server/resources/`).
2. `IA_CLASSIFY_BACKEND=word2vec pnpm dev`.
3. Partie Helix de bout en bout, comparer le path noeud-par-noeud avec une partie
   identique sous `IA_CLASSIFY_BACKEND=stub`.

Tracé comme acceptance gate **hors workflow phase-gated** ; à valider sur la
prochaine session de playtest combinée avec les autres ambigus en attente.

## Ambigus non résolus (à valider en playtest)
- **3036 paliers `<33% / 33-66% / >66%`** sur `score_caps {conformite:7, creativite:12, eveil:10}` (Phase 1).
- **3036 mécanisme `N_INTERRUPT`** custom (Phase 1).
- **Stub classifieur 3036** : matching CONFORME/NON_CONFORME via descripteurs (Phase 5).
- **Critère de sortie Phase 5 non automatisé** : partie complète Helix / 3036 (Phase 5).
- **Critère Phase 6 ≥80% match stub** : voir section dédiée ci-dessus.

## Dette ops
- **End.external_id** ajouté en Phase 5. Réimporter les scénarios scripted via
  `/admin/scenario/import` pour les peupler.
- **Pas de classification 3036 côté `word2vec`** : `classifyWord2vec` ne pose
  jamais `classification`, donc les noeuds 3036 qui filtrent par `classification_is:`
  tombent en fallback no-match sous ce backend. Attendu par le design (Phase 7
  LLM résout ça). Garder `stub` en défaut pour 3036 jusqu'à Phase 7.

## Prochaine étape
`/phase start 7` — LLM-backed `/api/classify` (optionnel selon plan §12). Livrables :
`classify.go` ajoute un mode `--backend=llm` (Claude API configurable, fallback
word2vec), feature flag étendu en `stub|word2vec|llm`.

## Journal des commits récents
- (Phase 6 non commit — en attente d'OK utilisateur)
- `5cd6f8c` feat(phase-5): runtime scripted serveur + UI joueur + dispatch addNode
- `d264c56` chore(claude): invoquer fixture-auditor depuis /phase finish quand YAML modifié
- `cb317a5` ci: ajouter checks pnpm check + pnpm test:narrative sur PRs
- `ed7a3b4` docs(status): rafraîchir STATUS.md à l'état post-Phase 4 + 3bis
- `d050c69` chore(claude): versionner le setup agentique projet
- `714f3d1` docs(design): restructurer §12 phases livrées + découpage Phase 5
