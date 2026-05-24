# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

"Babel Révolution" (a.k.a. New Babel Revolution) is a SvelteKit application for collaborative narrative "sessions" built around scenarios. Authenticated users (admins) create scenarios and sessions; participants then contribute nodes (text, optional audio) onto a tree graph that branches off a scenario's start. An optional Go-based AI server can moderate contributions, trigger events, and end sessions automatically.

Primary language for UI copy, commit messages, and many code comments is **French**. Keep that convention when editing — don't silently translate user-facing strings.

## Commands

Package manager is **pnpm** (see `packageManager` in `package.json`). Don't substitute `npm` or `bun`.

- `pnpm dev` — Vite dev server (the working loop; SSR is disabled in `src/routes/+layout.ts`, so the app runs as an SPA with SvelteKit acting as the API/form-actions backend).
- `pnpm build` then `pnpm preview` — production build via `@sveltejs/adapter-node` and local preview. `pnpm start` runs `./build/index.js`; `pnpm start:remote` runs it with `.env.prod` loaded.
- `pnpm check` / `pnpm check:watch` — `svelte-kit sync` + `svelte-check` typecheck.
- `pnpm lint` / `pnpm lint:fix` — ESLint (config in `eslint.config.js`; enforces tabs, single quotes, semicolons, unix linebreaks, and `_`-prefixed unused-var ignore).
- `pnpm test:unit` — Vitest. Tests live under `tests/units/**/*.test.ts` (see `vitest.config.ts`). Run a single test with `pnpm test:unit tests/units/scenario.test.ts` or filter by name via `-t '<pattern>'`.
- `pnpm run ia` — starts the Go AI server (`ia_server/cmd/lauchServer`, port 8000). Requires Go installed. Some word2vec/dictionary resource files are gitignored — see `ia_server/resources/`.
- PocketBase locally: `docker compose up pocketbase` (port 8090, admin UI at `/_/`). Import the schema from `db/schema.json` via Settings → Import collections on first run.

There is no `format` script; ESLint owns formatting rules.

## Architecture

### Three services

1. **SvelteKit app** (`src/`) — front-end + form actions + a small `src/routes/api/` for AI health/session bootstrap.
2. **PocketBase** (`db/`) — the database and auth provider. The schema is checked in as `db/schema.json`. There is no ORM; code talks to PocketBase via the `pocketbase` JS SDK.
3. **Go AI server** (`ia_server/`) — censorship/moderation, scenario→session bootstrap, word2vec lookups, OMWfr/Wiktionnaire dictionaries. Endpoints: `/api/health`, `/api/checkMsg`, `/api/newSession` (see `src/lib/server/ia/index.ts` and `ia_server/webservice/`). The Svelte side degrades gracefully if `IA_SERVER_URL` is unset or unreachable.

`docker-compose.yml` wires all three for full-stack runs; individually each can run on its own port.

### PocketBase access (split client/server)

There are intentionally two PocketBase entry points — don't merge them:

- `src/lib/client/pocketbase.ts` — singleton `pb` for browser code, uses `PUBLIC_DB_URL`, `autoCancellation(false)`.
- `src/lib/pocketbase.ts` — `createPocketBase()` factory for server code, uses the private `DB_URL`. Server-side form actions also instantiate `new PocketBase(DB_URL)` directly in some places (e.g. `src/routes/sessions/[slug=number]/+page.server.ts`).

The `MyPocketBase` interface in `src/types/pocketBase/index.ts` adds typed `collection()` overloads for `Node`, `Scenario`, `End`, `Event`, `Session`, `Side`, `Users`. Prefer those typed collection names verbatim.

### Auth and roles

- Auth state lives in the client-side `pb.authStore`. `src/routes/+layout.ts` loads it and exposes `{ user, isAdmin, isSuperAdmin }` to all pages. Roles are `superAdmin` / `admin` (everyone else is treated as a regular user).
- Server actions that mutate admin-only resources receive `pb_cookie` from form data and call `pb.authStore.loadFromCookie(pb_cookie)` before checking `role === 'superAdmin'` (see `addEvent` / `endSession` in the sessions `+page.server.ts`). Follow that same pattern for new admin-gated actions — don't bypass it.
- `src/app.d.ts` declares `App.Locals.pb` and `ServerLoadEvent.user`, but most data flow currently goes through the client `pb` instance because of `ssr = false`.

### Routes

- `(home)` — public landing.
- `(auth)/login` — login.
- `sessions/[slug=number]/` — the core session view. `slug` is constrained by `src/params/number.ts`. `+page.server.ts` exposes form actions `addNode`, `addEvent`, `endSession`. `MainGraph.svelte` + `GraphUI/*` render the D3-based contribution tree.
- `admin/` — admin layout gates on role; subtrees `scenario/create`, `sessions/create`, `user/create`.
- `api/ai/health` and `api/ai/newAiSession` — thin proxies to the Go AI server.
- `design-system/` — internal component gallery.

### Path aliases

Configured in `svelte.config.js`:

- `$components` → `src/components`
- `$stores` → `src/stores`
- `$types` → `src/types`
- `$lib` → `src/lib` (SvelteKit default)

shadcn-svelte is configured (`components.json`) with aliases pointing into `$lib/components/ui`. Only a handful of primitives are vendored under `src/lib/components/ui/` (`dropdown-menu`, `select`, `separator`) — most form/UI primitives are hand-rolled under `src/components/`.

### Domain layer

Cross-cutting domain helpers live under `src/lib/`:

- `nodes/`, `scenario/`, `sessions.ts` — CRUD/orchestration helpers used by both client and server.
- `server/ia/` — the only IA client code; kept server-side so the private `IA_SERVER_URL` never reaches the bundle.
- `zschemas/` — Zod schemas used for form-action validation (`addNode.schema`, `createSession.schema`, `event.schema`, `pseudo.schema`, `scenario.schema`, plus an `ia/` subfolder). When adding a form action, write the schema here and `safeParse` before touching the DB.
- `mainGraph/values.ts`, `nodes/index.ts` — graph layout constants and node helpers consumed by `MainGraph.svelte` and the D3 rendering code.
- `runes/`, `actions/`, `animations/` — Svelte 5 rune-based stores, Svelte actions, and transition helpers respectively.

### i18n

`svelte-i18n` with default locale `fr-FR` and fallback `en-US`. Initialized in `src/routes/hooks.server.ts` (and `hooks.client.ts`). Translations under `src/lang/`. Use the `$t('key')` store in templates rather than hard-coding strings.

### Environment

- `.env` holds production-default URLs (committed). `.env.local` (gitignored) overrides for local dev — dotenv loads it first in `svelte.config.js`. `.env.prod` is loaded only by `pnpm start:remote`.
- Required keys: `PUBLIC_DB_URL`, `DB_URL`, optionally `IA_SERVER_URL`, `CSRF_CHECK_ORIGIN`. CSRF trusted origins are only enforced when `CSRF_CHECK_ORIGIN=true`.

## Conventions and style

- **TypeScript strict** is on. `allowJs` and `checkJs` are also on — JS files in this repo are typechecked, so don't bypass with `// @ts-ignore` without a reason.
- **Tabs**, single quotes, semicolons, unix newlines — enforced by ESLint. `svelte/indent` is configured for tabs with `switchCase: 0`.
- Svelte 5 syntax is the norm (`$props`, `$effect`, `$state`, snippets). Don't reintroduce Svelte 4 patterns (`export let`, `$: ` reactive statements, slots) when editing existing components.
- `src/types/TableType.d.ts` declares a global `TableTypes` namespace alongside the newer `src/types/pocketBase/TableTypes.d.ts`. Prefer importing from `$types/pocketBase/TableTypes` for new code.
- French is fine in identifiers, comments, and commit messages — it's the project's working language. UI copy lives in `src/lang/`.

## Deployment

- `staging` branch auto-deploys via `.github/workflows/deploy.yml` (rsync → SSH → `docker-compose up -d --build` on the remote host). PRs target `staging`.
- `.github/workflows/docker.yml` pushes a `doradea/babel-revolution:latest` image on pushes to `main` / `maty`.
- A Discord webhook notification fires on `staging` pushes (`webhooks.yml`).
