# STATUS — 2026-05-25 (post-Phase 5)

## Phase courante
Prêt à démarrer Phase 6 (Endpoint Go `/api/classify` word2vec, cf.
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
  - 5.1 `createScriptedSession()` côté admin + dropdown engine-aware (`+page.svelte`
    branche `createStartNode` selon engine).
  - 5.2 `classifyStub(text, prompt_ia, intents)` hermétique (keyword matching + fallback
    premier intent ; pose `classification` ssi label ∈ taxonomie 3036).
  - 5.3 `progressScripted(pb, sessionId, text, classifier)` : bridge PB id ↔ external_id
    (Session.current_node relation, Session.end relation), load + compile + step +
    persist en un round-trip. Ajout `End.external_id` au schema PB.
  - 5.4 Branche `engine === 'scripted'` dans l'action form `addNode` (helper testable
    `isScriptedScenario()` dans `engine-dispatch.ts`). Free path inchangé.
  - 5.5 `ScriptedPlayer.svelte` : noeud courant + textarea + sidebar
    (actions/scores/preuves/warnings) + écran de fin. Validation visuelle supervisée.

## Tests
- `pnpm check` : ✅ 0 errors (3 warnings pré-existants hors scope).
- `pnpm test:narrative` : ✅ **143/143 PASS** (92 → 143 = +51 tests sur la Phase 5).
- `pnpm test:unit` (suite complète sans cible) : ❌ pré-existant `scenario.test.ts`
  qui importe `$lib/i18n` non résoluble par Vitest. **Dette à régler à un moment** ;
  ne pas le toucher avant Phase 6.

## Ambigus non résolus (à valider en playtest)
- **3036 paliers `<33% / 33-66% / >66%`** sur `score_caps {conformite:7, creativite:12, eveil:10}` — choix conservateur de la nuit autonome, à confirmer sur 1 partie test après Phase 5.5.
- **3036 mécanisme `N_INTERRUPT`** custom (déclenche `FIN_INTERROMPUE` par effet `end:` sur 2e refus non-coopératif) — à confirmer comme fidèle au PDF.
- **Stub classifieur 3036** : le matching CONFORME/NON_CONFORME via descripteurs lowercase est best-effort, le scoring peut tomber en fallback sur prompts narratifs. Validation Phase 6 word2vec apportera la précision.
- **Critère de sortie Phase 5 non automatisé** : « partie complète Helix → FIN_REUSSITE / 3036 → FIN_CITOYEN_STABLE+FIN_EVEILLE ». Couvert en sous-éléments par `runtime-scripted.test.ts` (atteinte d'une fin via `actions_left: 0`) mais e2e manuel obligatoire à la prochaine session de playtest.

## Dette ops Phase 5
- **End.external_id** ajouté au schema. Les ends importés en BD avant Phase 5 ont ce
  champ vide → réimporter les scénarios scripted (`helix-corp.yaml`, `3036.yaml`) via
  `/admin/scenario/import` pour les peupler. Sinon `progressScripted` ne pourra pas
  résoudre `state.ended_with` ↔ `Session.end` au moment d'atteindre une fin.

## Prochaine étape
`/phase start 6` — Endpoint Go `/api/classify` word2vec. Livrables :
`ia_server/webservice/classify.go`, `src/lib/server/ia/classify.ts`, feature flag
`IA_CLASSIFY_BACKEND=stub|word2vec`. Le stub TS de Phase 5.2 reste l'implémentation
par défaut en absence de Go server.

## Journal des commits récents
- (Phase 5 non commit — en attente d'OK utilisateur)
- `714f3d1` docs(design): restructurer §12 phases livrées + découpage Phase 5
- `f4be1c0` fix(narrative): clamper actions_left à 0 pour éviter les valeurs négatives
- `2227469` fix(narrative): régression cross-module sur validateReferences (4 types de ref)
- `a4affea` fix(narrative): détecter les doublons d'external_id sur toutes les collections
- `02ef556` fix(narrative): propager le numéro de ligne dans YamlParseError
- `7cb4f1e` fix(narrative): rejeter condition: {} au niveau noeud/end dans Zod
- `347487d` fix(narrative): rejeter prédicats numériques sans comparateur dans Zod
- `3b183a6` chore(ops): ajouter RUNBOOK.md + agent runbook-keeper pour le maintenir
- `cb38f10` feat(phase-4): authoring scripted via /admin/scenario/import + batch transactionnel
- `9c5137f` merge: phases 1-3 du moteur narratif scripté (run autonome)
