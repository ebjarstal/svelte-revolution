# RUNBOOK

Gestes opérationnels pour faire tourner et déployer `babel-revolution`. Pour l'archi et les conventions, voir `CLAUDE.md`.

## Local dev — premier setup

1. `docker compose up pocketbase` (port 8090).
2. `http://localhost:8090/_/` → créer un superuser au premier lancement.
3. Settings → Import collections → charger `db/schema.json`.
4. Settings → Application → Batch API → **Enable** (experimental), Max requests = **100**. Sinon `/admin/scenario/import` renvoie 403.
5. `pnpm install` puis `pnpm dev`.

## Classifieur scripted (`IA_CLASSIFY_BACKEND`)

- Var d'env privée SvelteKit. Valeurs : `stub` (défaut, classifieur TS local) ou `word2vec` (appelle Go `POST /api/classify`). Non set = `stub`.
- `word2vec` nécessite `ia_server/resources/model.bin` (~plusieurs Go, non versionné). Absent → endpoint répond 503, **rester sur `stub`** en local.
- Pour switcher : ajouter `IA_CLASSIFY_BACKEND=word2vec` dans `.env.local` (+ `IA_SERVER_URL` set + `pnpm run ia`), puis `pnpm dev`.
- **3036** : `word2vec` ne pose pas `classification` (CONFORME/…) → nœuds avec `classification_is:` tombent en no-match. Garder `stub` pour 3036 jusqu'à Phase 7 (LLM).

## Sync schéma PocketBase

- Toute modif de `db/schema.json` (sur main ou ta branche) → réimporter via PB admin. Ajouts additifs : données préservées. Drops : PB prévient avant.
- Phase 4 a droppé `TriggerNodes`. Vérifier qu'elle est vide en prod **avant** de réimporter là-bas.
- Phase 5 a ajouté `End.external_id`. Sur env avec scénarios scripted pré-Phase-5 : réimporter schéma, puis pour chaque scénario scripted, supprimer la row `Scenario` (cascade Nodes/Ends/Characters/Evidences/StateAxes) et réimporter le YAML via `/admin/scenario/import`. Sinon `Session.end` ne sera pas renseigné en fin de partie.

## Settings PocketBase requis (toutes envs)

- **Batch API activé**, Max requests ≥ 100. Indispensable à `/admin/scenario/import`.

## Déploiement staging

- Push sur `staging` → `.github/workflows/deploy.yml` (rsync + ssh + docker-compose).
- Pré-flight PB staging : Batch API activé (cf. ci-dessus). Vérifier avant push.
- Si `db/schema.json` changé dans la PR : réimporter le schéma sur PB staging après deploy.

## Déploiement prod

- Push sur `main` ou `maty` → `.github/workflows/docker.yml` build `doradea/babel-revolution:latest`.
- Mêmes pré-flights PB que staging.

## Vérifs post-deploy

- `curl https://<host>/api/ai/health` (skip si `IA_SERVER_URL` non configuré).
- Login superAdmin → `/admin/scenario/import` → upload `scenarios/fixtures/helix-corp.yaml` → récap doit afficher 4/10/0/47/3 (chars/preuves/axes/nœuds/fins).
- Acceptance Phase 6 (manuel, non-CI) : jouer Helix de bout en bout sous `IA_CLASSIFY_BACKEND=word2vec` puis rejouer les mêmes inputs sous `stub`, viser ≥80% de chemin de nœuds identique.
