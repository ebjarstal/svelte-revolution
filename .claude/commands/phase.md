---
description: Workflow phase-gated pour la feature narrative engine. Usage `/phase start N` ou `/phase finish N` (N=1..7).
argument-hint: start|finish N
---

# Phase $ARGUMENTS

Tu travailles sur la feature narrative engine du projet (cf. `docs/narrative-engine-design.md` §12). Le workflow est strictement phase-gated : tu termines une phase et tu **attends "go phase suivante"** avant d'entamer la prochaine.

## Si `start N`

1. Lis `docs/narrative-engine-design.md` — focus sur §12 (résumé phase N), puis les sections référencées par ce critère de sortie. **Ne lis pas le doc entier**.
2. Lis `STATUS.md` pour récupérer l'état des phases précédentes et les ambigus non résolus.
3. Lis `git log --oneline -20` pour le contexte récent.
4. Ouvre un plan numéroté (TaskCreate) qui couvre **uniquement** la phase N. Un task = un livrable testable. Inclue toujours en dernière tâche : « invoquer `phase-reviewer` avec spec §N et liste des fichiers touchés ».
5. Annonce le plan à l'utilisateur en 5-10 lignes maximum, puis attends "go" avant d'écrire la moindre ligne de code.

Le hook PostToolUse projet relancera automatiquement `pnpm test:narrative` à chaque édition de `src/lib/narrative/**`, `tests/units/narrative/**`, ou `scenarios/fixtures/**`. Lis sa sortie dans le transcript.

## Si `finish N`

1. Lance `pnpm check` et `pnpm test:narrative`. Si rouge, fix d'abord.
2. Confirme via `git status` et `git diff --stat` que les changements sont scopés à la phase N (rien d'autre). Si tu vois du drift hors-scope, surface-le à l'utilisateur — ne le commit pas silencieusement.
3. Invoque `phase-reviewer` (subagent) en lui passant :
   - le critère de sortie de la phase N depuis `docs/narrative-engine-design.md` §12,
   - la liste des fichiers modifiés (`git diff --name-only` vs base de la phase),
   - une note 3 lignes max de ce que tu as fait.
4. Si verdict **PASS** :
   - Mets à jour `STATUS.md` : phase courante → N+1, phase complétée → N (avec tests et fichiers touchés).
   - Si la phase a touché un setting opérationnel (env var, schema BD, nouvelle commande, batch API…), invoque `runbook-keeper` avec un résumé.
   - Si la phase a modifié l'architecture (nouveau module, nouveau collection, nouvelle convention), invoque `claude-md-auditor`.
   - Si la phase a modifié `scenarios/fixtures/*.yaml` (création ou édition), invoque `fixture-auditor` sur chaque fixture touché (un appel par fixture, en passant le chemin en argument).
   - Propose un message de commit à l'utilisateur (n'exécute pas `git commit` sans son OK).
5. Si verdict **NEEDS WORK** ou **BLOCKER** : adresse chaque finding cité, ré-invoque le reviewer. **Hard limit : 2 cycles**. Au 3e, escalade à l'utilisateur.

## Hors workflow

- Ne touche jamais aux fichiers de free-engine (`src/routes/sessions/[slug=number]/+page.server.ts` action `addNode`, `/api/checkMsg`, etc.) sans lire d'abord §11 du design.
- Les ambigus PDF rencontrés en cours de route → commentaire `AMBIGU:` dans le YAML/code + entrée dans `STATUS.md`, pas une décision silencieuse.
