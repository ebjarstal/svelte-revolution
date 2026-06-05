# Deployment (production)

How `babel-revolution.ebjrstl.com` is deployed. Read this before touching prod — there are a few
non-obvious landmines (compose, env, schema) that can take the site down or orphan the live DB.

## Topology

- **Host:** OVH VPS, reachable over SSH (operator config aliases it as host `OVH`, user `ubuntu`).
- **App lives at:** `/srv/web/babel-revolution` on the server.
- **nginx → 3 Docker containers** (compose project `svelte-revolution`):
  - `sveltekit_c` — the SvelteKit app (adapter-node), bound to `127.0.0.1:8080`.
  - `pocketbase_c` — PocketBase, bound to `127.0.0.1:8090`. Data in the named volume
    `svelte-revolution_pocketbase-data`, mounted at **`/pb_data`**.
  - `iaserver_c` — Go word2vec censorship server on internal `:8000` (not proxied by nginx;
    reached in-app via `IA_SERVER_URL`). The LLM "gamemaster" itself runs **inside SvelteKit/TS**,
    not here.
- **nginx routes:** `/api/pb/(.*)` → `127.0.0.1:8090` (the `/api/pb` prefix is stripped),
  `/_/` + `/api/` → 8090, everything else (`/`, `/api/ai/`) → 8080.
- **Public URLs:** site `https://babel-revolution.ebjrstl.com` ·
  PocketBase API `…/api/pb` · PocketBase admin UI `…/api/pb/_/`.

## Git remote & deployed branch

- The server's git `origin` is **`git@babel:ebjarstal/svelte-revolution.git`** (the `babel` SSH
  alias = github.com with a deploy key). `ebjarstal/svelte-revolution` is a fork of
  `LaDorade/svelte-revolution`; both are kept in sync, but **ebjarstal is the source of truth for
  deploys**.
- **Deployed branch: `staging`.** Merge to `staging` (PR flow) is what reaches prod.

## Deploy a new version

```sh
ssh OVH
cd /srv/web/babel-revolution

# 1. ALWAYS back up the DB volume first
docker run --rm -v svelte-revolution_pocketbase-data:/data:ro -v ~/backups:/backup \
  alpine tar czf /backup/pb_data_$(date +%Y%m%d-%H%M%S).tar.gz -C / data

# 2. Pull the deployed branch
git pull origin staging

# 3. Rebuild + recreate (full)
docker compose --env-file .env.prod up --build -d
# …or, for an app-only code change, rebuild just SvelteKit:
docker compose --env-file .env.prod build sveltekit
docker compose --env-file .env.prod up -d --no-deps sveltekit
```

`--env-file .env.prod` is required (see env table below).

## ⚠️ Landmines (read these)

### 1. The committed `docker-compose.yml` is NOT what prod runs
The repo's `docker-compose.yml` targets local dev: it binds ports to `0.0.0.0` and mounts the PB
volume at `/app/pb_data`. **In prod both are wrong** — `0.0.0.0` would expose PocketBase/SvelteKit
publicly (bypassing nginx/TLS), and PocketBase actually writes to `/pb_data`, so mounting the volume
at `/app/pb_data` would orphan the live database (the site would look wiped).

Prod runs a **hand-edited `docker-compose.yml` that is NOT committed** (ports on `127.0.0.1`,
volume on `/pb_data`, `env_file: .env.prod` + `restart: unless-stopped` on iaserver). Do **not**
overwrite it with `git checkout`/`git pull` of that file. A backup lives in `~/backups/docker-compose.yml.prod-*`.
(Long-term: this should become a committed `docker-compose.prod.yml`.)

### 2. `.env.prod` holds the real secrets and is baked into the image
`.env.prod` is tracked but **locally overridden on the server** with the real prod values. It is
**baked into the SvelteKit image** (`.dockerignore` does not exclude it) and loaded at runtime by
`start:remote` = `node --env-file=.env.prod ./build/index.js`. It must contain at least:
`DB_URL=http://pocketbase:8090`, `MISTRAL_API_KEY`, `IA_SERVER_URL=http://iaserver:8000`,
`ORIGIN=https://babel-revolution.ebjrstl.com`, `PB_SUPERUSER_EMAIL` + `PB_SUPERUSER_PASSWORD`
(see below), plus `CSRF_CHECK_ORIGIN`, `PUBLIC_DB_URL`. Because `.env.prod` is baked at build time,
**any change to it requires a SvelteKit rebuild** (`build sveltekit` + recreate), not just a restart.

### 2b. The gamemaster needs a dedicated PocketBase superuser
Playing a gamemaster session persists `Session.state`, a privileged write that authenticates as a
PocketBase **_superuser** using `PB_SUPERUSER_EMAIL`/`PB_SUPERUSER_PASSWORD` (read at runtime in
`src/lib/server/gamemaster/turn.ts`). If these are unset or don't match a real superuser, every turn
fails with "The game master is temporarily unavailable." Create a permanent one and point the env
vars at it:

```sh
docker exec pocketbase_c /pocketbase superuser create gamemaster@babel-revolution.local <pass>
# then set PB_SUPERUSER_EMAIL / PB_SUPERUSER_PASSWORD in .env.prod to match, and rebuild sveltekit
```
(This is distinct from the app `Users` accounts and from the legacy, now-unused `PB_BOT_*` vars.)

### 3. Server-side DB access must use the *runtime* env
In SvelteKit server code, read `DB_URL` (and other runtime config) via **`$env/dynamic/private`**
(`env.DB_URL`), never `$env/static/private`. `$env/static/private` inlines the value at **build**
time, where it resolves to the dev `localhost:8090` (from `.env.local`, `override: true` in
`svelte.config.js`) — unreachable from inside the container, so every PB call 401s. See
`src/lib/pocketbase.ts` for the correct pattern.

### 4. Schema changes are NOT auto-applied
`db/schema.json` must be imported manually after a schema change. Either via the admin UI
(`…/api/pb/_/` → Settings → Import collections) **or** via the API with a PocketBase **superuser**
(distinct from the app `Users` accounts). When no superuser is on hand, create a throwaway one:

```sh
docker exec pocketbase_c /pocketbase superuser create <email> <pass>
# auth → POST /api/collections/_superusers/auth-with-password  (get token)
# import: PUT /api/collections/import  body {"deleteMissing": <bool>, "collections": <db/schema.json array>}
docker exec pocketbase_c /pocketbase superuser delete <email>
```

**Gotcha:** never pipe the JSON body through `echo` — it mangles the regex backslashes in the
schema and PB replies `400 "error loading the submitted data"`. Write the body to a file and
`curl --data-binary @file`. `db/schema.json` contains all 14 collections, so `deleteMissing=true`
is safe (drops only collections/fields no longer in the schema). Records survive a schema import.

### 5. Never `docker compose down -v`
The `-v` destroys the data volume. Use `docker compose down` (no `-v`) to stop safely.

## Env files

| File | Used by | In git? |
|---|---|---|
| `.env` | Vite at build time · Compose default | Yes — non-secret defaults only |
| `.env.local` | local dev (`dotenv override:true` in `svelte.config.js`) | No (gitignored) — local secrets |
| `.env.prod` | SvelteKit runtime (`node --env-file`) · `docker compose --env-file` | Yes, but locally overridden on the server with real secrets |

## Who can upload scenarios

Any authenticated **`Users`** account (any role — `user`/`admin`/`superAdmin`); the `Scenario`/`Side`
create rules are `@request.auth.id != ""`. This is the app login, **not** a PocketBase superuser.
After a redeploy, log out/in to mint a fresh token if you hit auth errors.
