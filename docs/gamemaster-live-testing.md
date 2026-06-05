# Gamemaster live testing

How we verify that the LLM-gamemaster scenarios (`scenarios/*.yaml`) are *actually playable*
against the real Mistral API — and how to read the reports it produces.

## Why this exists

There are two complementary layers of tests:

| Layer | File | Player input | Proves |
|-------|------|--------------|--------|
| **Offline engine** | `tests/units/gamemaster-engine.test.ts` | hand-written labels | the deterministic engine reaches every authored ending when fed the right classifications |
| **Live playthrough** | `tests/units/gamemaster-fullrun.live.test.ts` | natural-language prose → **real Mistral** | the model *classifies real player prose* into the labels/targets/evidence the engine needs |

The offline layer can't catch a weak classifier prompt: it assumes perfect classification. The
live layer closes that gap — it answers "if a human types like this, does the scenario actually
progress?"

## How to run

```sh
MISTRAL_LIVE=1 pnpm exec vitest run tests/units/gamemaster-fullrun.live.test.ts
```

- Reads `MISTRAL_API_KEY` from `.env.local`.
- **Makes real, billed Mistral calls** (~1 per turn, ~16 total for both scenarios).
- Without `MISTRAL_LIVE=1` the suite is **skipped** (so normal `pnpm test:unit` stays offline/free).

## What it produces

Artifacts are written under `tests/output/` (gitignored) and **archived per run**:

```
tests/output/
  README.md                 # archive index of every run (newest first) + how-to
  latest/                   # convenience copy of the most recent run
  runs/<run-id>/            # one folder per invocation (ISO-timestamp id)
    index.md                # cross-scenario summary for that run
    <scenario>.md           # full human report (see below)
    <scenario>.json         # complete structured trace (machine-readable)
    manifest.json           # one-line-per-scenario summary (drives the archive index)
```

Each `<scenario>.md` report contains:

- **Objective** — what that run is trying to demonstrate.
- **Summary** — prose: did it reach the goal ending, label/target/evidence accuracy, and if it
  stalled, *where and why*.
- **Classification scorecard** — accuracy %, fallbacks, stuck turns, latency.
- **Path** — a **Mermaid flow diagram** of the nodes visited; green = ending reached, dashed red
  self-arrow = a turn where no transition matched (a stall).
- **Transcript** — per turn: player message, AI classification, ✓/✗ vs. expectation, node moved to,
  state change.
- **Narration** — the authored text the player would actually see.
- **Routing detail** (collapsible) — every candidate transition the engine evaluated and which one
  won; this is what makes a stall debuggable.
- **Warnings** and **final game state**.

## Architecture

The harness never re-implements routing — it calls the production engine
(`src/lib/server/gamemaster/engine.ts`: `initState`, `step`, `gatherCandidates`, and
`guards.ts: evalPredicate`) so the trace is faithful to what runs in `turn.ts` live.

- `tests/helpers/gamemaster-trace.ts` — runs a playthrough, captures the structured `RunTrace`.
- `tests/helpers/gamemaster-report.ts` — renders `RunTrace` → Markdown + JSON + Mermaid + indices.

## Interpreting accuracy

A scenario that **stalls** (no transition matched) means the model returned a classification the
current node has no edge for — usually a **classifier-prompt ambiguity**, not an engine bug. The
routing-detail section shows the exact `when` guards that were available, so you can see whether the
fix belongs in the *scenario YAML* (clearer classifier instructions / a more permissive guard) or in
the *test message* (unnatural wording).
