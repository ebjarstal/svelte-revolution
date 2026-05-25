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
- `pnpm test:unit` — Vitest watch mode. Tests live under `tests/units/**/*.test.ts` (see `vitest.config.ts`). Run a single test with `pnpm test:unit tests/units/<name>.test.ts` or filter by name via `-t '<pattern>'`. **Note:** the legacy `tests/units/scenario.test.ts` imports `$lib/i18n` which Vitest can't resolve, so `pnpm test:unit` against the whole suite fails until that alias is fixed.
- `pnpm test:narrative` — runs only `tests/units/narrative/` in single-shot mode. Use this for the scripted-engine work (it includes `persist-scripted.integration.test.ts`, which stubs the PocketBase batch SDK so no live DB is required). A project-level `.claude/settings.json` PostToolUse hook also auto-runs this script whenever you edit `src/lib/narrative/**`, `tests/units/narrative/**`, `scenarios/fixtures/**`, `src/lib/zschemas/scripted-scenario.schema.ts`, or the three `src/lib/scenario/{pb-id,validate-references,persist-scripted}.ts` modules — read its tail in your transcript to catch regressions early.
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

The `MyPocketBase` interface in `src/types/pocketBase/index.ts` adds typed `collection()` overloads for `Node`, `Scenario`, `End`, `Event`, `Session`, `Side`, `Users`, `Characters`, `Evidences`, `StateAxes`. Prefer those typed collection names verbatim.

### Auth and roles

- Auth state lives in the client-side `pb.authStore`. `src/routes/+layout.ts` loads it and exposes `{ user, isAdmin, isSuperAdmin }` to all pages. Roles are `superAdmin` / `admin` (everyone else is treated as a regular user).
- Server actions that mutate admin-only resources receive `pb_cookie` from form data and call `pb.authStore.loadFromCookie(pb_cookie)` before checking `role === 'superAdmin'` (see `addEvent` / `endSession` in the sessions `+page.server.ts`). Follow that same pattern for new admin-gated actions — don't bypass it.
- `src/app.d.ts` declares `App.Locals.pb` and `ServerLoadEvent.user`, but most data flow currently goes through the client `pb` instance because of `ssr = false`.

### Routes

- `(home)` — public landing.
- `(auth)/login` — login.
- `sessions/[slug=number]/` — the core session view. `slug` is constrained by `src/params/number.ts`. `+page.server.ts` exposes form actions `addNode`, `addEvent`, `endSession`. `MainGraph.svelte` + `GraphUI/*` render the D3-based contribution tree.
- `admin/` — admin layout gates on role; subtrees `scenario/create`, `scenario/import` (scripted YAML upload), `sessions/create`, `user/create`.
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

- `nodes/`, `sessions.ts` — CRUD/orchestration helpers used by both client and server.
- `scenario/` — mixed: `index.ts` holds the legacy free-engine CRUD (`createScenario`, `createEventsAndEnds`) usable both client- and server-side. The three Phase-4 modules `pb-id.ts`, `validate-references.ts`, `persist-scripted.ts` are **server-only** (they use `pb.createBatch()` with a `MyPocketBase` instance built from the private `DB_URL`) — see the « Scripted narrative engine » section below for the import pipeline.
- `narrative/` — pure runtime for the **scripted scenario engine** (cf. dedicated section below). Hermetic: never import `$lib/i18n` or any Svelte-dependent code here. Public API via `$lib/narrative` (`parseYaml`, `compile`, `step`, `evaluate`, `applyEffect`, plus runtime types).
- `server/ia/` — the only IA client code; kept server-side so the private `IA_SERVER_URL` never reaches the bundle.
- `zschemas/` — Zod schemas used for form-action validation (`addNode.schema`, `createSession.schema`, `event.schema`, `pseudo.schema`, `scenario.schema`, `scripted-scenario.schema` for YAML fixtures, plus an `ia/` subfolder). When adding a form action, write the schema here and `safeParse` before touching the DB. `scripted-scenario.schema` is hermetic — no `svelte-i18n` import.
- `mainGraph/values.ts`, `nodes/index.ts` — graph layout constants and node helpers consumed by `MainGraph.svelte` and the D3 rendering code.
- `runes/`, `actions/`, `animations/` — Svelte 5 rune-based stores, Svelte actions, and transition helpers respectively.

### Scripted narrative engine

Two scenario runtimes coexist, discriminated by `Scenario.engine: 'free' | 'scripted'`:

- **`free`** — the original collaborative mode: players freely contribute nodes onto a tree, the Go IA server moderates, an admin picks the end. All pre-existing code paths (graph rendering, `addNode`/`addEvent`/`endSession` form actions, IA server's `/api/checkMsg` + `/api/newSession`) belong to this mode.
- **`scripted`** — pre-authored solo narrations (intent-classified branching, evidence flags, score axes, action budget, auto-selected ends). Lives entirely under `src/lib/narrative/` and is **pure** (no DB, no IO, no Svelte). The canonical spec is **`docs/narrative-engine-design.md`** — section references inside narrative source comments (`§3`, `§4`, `§7.2`, etc.) all resolve there.

**Schema additions for scripted mode** (cf. design doc §3, fully additive — free-mode sessions are unaffected):

- New collections: `Characters` (PNJ per scenario), `Evidences` (unlockable flags), `StateAxes` (named score axes).
- `Scenario` gained `engine`, `rules`, `characters`, `evidences`, `state_axes`.
- `Node` gained `external_id`, `is_start`, `consumes_action`, `prompt_ia`, `intents`, `condition`, `effects` (all nullable).
- `Session` gained `current_node`, `visited_nodes`, `evidences`, `scores`, `warnings`, `actions_left`, `last_intent`, `last_classification`.
- `End` gained `condition`, `priority`.

**Scenario fixtures** live in `scenarios/fixtures/*.yaml`. They are the authoring source-of-truth (validated by `scripted-scenario.schema.ts`, compiled at load time by `src/lib/narrative/compile.ts`). Format is specified in `docs/narrative-engine-design.md` §10. Two fixtures ship with the repo: `helix-corp.yaml` and `3036.yaml`.

**Authoring entry point** (Phase 4) — a superAdmin imports a YAML fixture via `/admin/scenario/import` (`src/routes/admin/scenario/import/`). The form-action pipeline is `parseYaml → scriptedScenarioSchema.safeParse → compile → validateReferences → persistCompiledScenario`. The last two steps live in `src/lib/scenario/`:

- `validate-references.ts` walks each `condition`/`effects`/`rules` tree and reports any `external_id` (node / evidence / character / state axis / end) that's not declared in the same fixture.
- `persist-scripted.ts` pre-generates 15-char `[a-z0-9]` IDs (helper in `pb-id.ts`) for the Scenario + every Character/Evidence/StateAxis/Node/End, then writes the whole graph in a single PocketBase transactional batch (`pb.createBatch()`, SDK 0.26+). A `BatchPersistError` is thrown on partial failure — PB rollbacks the transaction server-side.

Mapping notes (cohabitation with the free schema): `Scenario.firstNodeTitle/Text/Author` is populated from the scripted startNode + uploader id; `Scenario.lang` maps the YAML locale prefix to the PB enum (`fr-FR` → `fr`); `Node.type` is `'startNode'` for `is_start`, `'contribution'` otherwise; `Node.author` is the uploader's id.

When extending the scripted engine, conform to the design doc rather than improvising — if the design feels wrong, propose an edit to the design doc *first*, then implement.

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
