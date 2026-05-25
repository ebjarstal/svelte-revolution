# STATUS — 2026-05-25 (post-Phase 4 + 3bis)

## Phase courante
Prêt à démarrer Phase 5 (Runtime scripted serveur + UI joueur, cf.
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

## Tests
- `pnpm check` : ✅ 0 errors (3 warnings pré-existants hors scope).
- `pnpm test:narrative` : ✅ **92/92 PASS**.
- `pnpm test:unit` (suite complète sans cible) : ❌ pré-existant `scenario.test.ts`
  qui importe `$lib/i18n` non résoluble par Vitest. **Dette à régler à un moment** ;
  ne pas le toucher avant Phase 5.

## Ambigus non résolus (à valider en playtest)
- **3036 paliers `<33% / 33-66% / >66%`** sur `score_caps {conformite:7, creativite:12, eveil:10}` — choix conservateur de la nuit autonome, à confirmer sur 1 partie test après Phase 5.5.
- **3036 mécanisme `N_INTERRUPT`** custom (déclenche `FIN_INTERROMPUE` par effet `end:` sur 2e refus non-coopératif) — à confirmer comme fidèle au PDF.

## Prochaine étape
`/phase start 5` dans une session fraîche. Le découpage en 5 sous-tâches
(5.1 session admin scripted, 5.2 stub classifieur TS, 5.3 runtime serveur,
5.4 branche `addNode` form action, 5.5 UI joueur) est explicité au §12
du design doc. Les sous-tâches 5.1-5.4 sont autonome-friendly ; 5.5 doit
être supervisée.

## Journal des commits récents
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
