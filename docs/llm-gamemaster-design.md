# LLM Gamemaster — Design

> Generic engine to make YAML-authored, LLM-driven scenarios (like `3036` and `helix`)
> playable on the existing nodes-graph platform. The LLM (**MistralAI**) reads each player
> contribution, classifies it, and the engine deterministically creates the next authored
> node and mutates per-session game state.
>
> Status: **DESIGN — awaiting review.** No implementation yet. Go server is out of scope.

---

## 1. Goal & the one mechanic

Both target scenarios are the **same abstract machine**:

> A library of **authored nodes** (a "script"), plus a per-session **state**
> (numeric variables + boolean flags + counters). Each turn the player writes a
> **contribution**; an **LLM classifies** it into a constrained label; **deterministic
> engine code** picks the next authored node, applies its effects to state, instantiates
> the node in the graph, and checks whether an **ending** condition is now met.

|                | **3036 (ARGO)**                                              | **Helix (sabotage mystery)**                                                  |
| -------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| LLM output     | label ∈ `CONFORME/NON_CONFORME/CRITIQUE/NON_COOPERATIF`        | `intent` (COMPRENDRE/SYSTEME/OBSERVER/SUSPECTER/PREUVE/ACCUSER…) + `target` (character) |
| State          | numeric `score_conformite/creativite/eveil/avertissement`     | boolean evidence flags `P1…P10` + `actions` counter (start 18) + `accused`     |
| Node trigger   | prior node + label                                            | prior node + intent + **flag guards** (e.g. "possède P2_ACCES_0307")           |
| Effects        | `+1` to scores                                                | unlock flags, `actions -= 1`                                                   |
| Endings        | score-threshold predicates                                   | flag-sufficiency + accusation correctness + time-out                          |

**Genericity = the engine knows none of this.** Everything scenario-specific lives in the
YAML: the state shape, the classifiers, the transitions, the effects, and the endings. Adding
a new LLM-gamemaster scenario = writing a YAML file. That is the whole brief.

### Design principle (from research)

Keep the LLM's job **narrow**: it only returns a **constrained classification** (Mistral
strict `json_schema` via the Zod `responseFormat` integration, `temperature: 0`, on a cheap
`ministral-8b`/`mistral-small`). **All routing, guards, effects and endings are evaluated in
deterministic TypeScript.** The LLM never picks node IDs and never mutates state — this is far
more reliable and fully testable. Narration text is **authored** (verbatim from the YAML),
because both scenarios already provide full prose per node. (Per-node LLM prose generation is
explicitly out of scope for v1; the schema leaves room for it later — see §9.)

---

## 2. Architecture

```
 Player writes contribution
        │  (SvelteKit form action: addNode)
        ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ SvelteKit server  src/lib/server/gamemaster/                  │
 │                                                               │
 │  1. load Scenario.script (compiled JSON) + Session.state      │
 │  2. gather candidate transitions from current node            │
 │  3. build constrained label set → call Mistral (classify)     │  ── @mistralai/mistralai
 │  4. match transition (label + guards over state)              │
 │  5. apply effects (vars/flags/counter) → write Session.state  │
 │  6. createNode(authored text of target node)  ── reuse        │  ── src/lib/nodes
 │  7. evaluate endings → if met, triggerEnd                     │
 └──────────────────────────────────────────────────────────────┘
        │
        ▼
 PocketBase realtime → graph re-renders the new node (existing machinery)
```

Reused as-is: the nodes graph, realtime subscription, `Node` rendering, `createNode()`
(`src/lib/nodes/index.ts`), `triggerEnd()` (`src/lib/server/ia/event.ts`), the `addNode` form
action shell (`src/routes/sessions/[slug=number]/+page.server.ts`).

New code (all TypeScript): `src/lib/server/gamemaster/` (engine + Mistral client + guard
evaluator), a YAML→JSON compiler (`src/lib/scenario/compile.ts`), Zod schemas for the script,
and an admin upload route.

The existing `censorNode` → Go `/api/checkMsg` path is **not used** by gamemaster scenarios.
Legacy scenarios are unaffected (they have no `script`).

---

## 3. Data model (PocketBase)

Per the chosen "compiled JSON blob" approach — **minimal migrations**:

### `Scenario` (add fields)
| field    | type | notes                                                                 |
| -------- | ---- | --------------------------------------------------------------------- |
| `script` | json | the compiled, validated scenario script (nodes, decisions, transitions, state schema, endings). `null` for legacy scenarios. |
| `engine` | text (select) | `'legacy'` \| `'gamemaster'`. Drives which code path runs. Default `legacy`. |

`title`, `prologue`, `lang`, `ai` stay. For gamemaster scenarios `prologue` mirrors
`script.prologue` for the existing prologue UI; `firstNode*` mirror the `start` node so the
existing `createStartNode` still works.

### `Session` (add field)
| field   | type | notes                                                                          |
| ------- | ---- | ------------------------------------------------------------------------------ |
| `state` | json | per-session runtime: `{ vars, flags, counters, currentNode, history, ended }`. Initialised from `script.state` at session creation. |

Concurrency: writes to `Session.state` use **optimistic read-modify-write** (re-read,
re-apply, retry on conflict). These scenarios are single-protagonist, so contention is low;
the existing realtime subscription already propagates `Session` changes to clients. (Multi-
player co-op on one session is a possible future concern — noted, not built.)

No new collections. `Side`/`Event`/`End` collections remain for legacy scenarios; gamemaster
scenarios encode sides/endings inside `script` and use a single default narration side.

---

## 4. The YAML scenario format

A scenario file has six top-level keys: `meta`, `prologue`, `state`, `classifiers`,
`nodes`, `endings`. Below is the **normative spec**; the two transcriptions
(`scenarios/3036.yaml`, `scenarios/helix.yaml`) are the conformance tests.

### 4.1 `meta`
```yaml
meta:
  id: "3036"            # stable slug
  title: "3036"
  lang: fr              # en | fr | jp
  schemaVersion: 1
```

### 4.2 `prologue`
Authored intro text shown before the first node (maps to existing prologue UI).
```yaml
prologue: |
  Bienvenue, citoyen. Vous êtes en l'an 3036. ...
```

### 4.3 `state` — the per-session state shape
```yaml
state:
  vars:                 # integers, mutated by effects, read by guards/endings
    score_conformite: 0
    score_creativite: 0
    score_eveil: 0
    avertissement: 0
  flags: []             # boolean; listing declares them (default false). Helix: [P1_SABOTAGE_CONFIRME, ...]
  counters:             # integers that typically count down; optional
    actions: 18         # helix only
  thresholds:           # named numeric bands reused by guards/endings (optional sugar)
    faible:  { lte: 1 }
    moyen:   { gte: 2, lte: 4 }
    eleve:   { gte: 5 }
```
`flags` may be declared as a bare list (defaults false) or `name: false`. `thresholds` is
optional readability sugar so endings can say `score_eveil: eleve` instead of repeating
`{ gte: 5 }`.

### 4.4 `classifiers` — reusable LLM classification specs
A classifier is the "Prompt IA d'évaluation" plus the constrained label set it may return.
Nodes reference a classifier by id (so 3036's three variant nodes that all ask the "lieu"
question share one classifier; helix's intent taxonomy is one shared classifier).

```yaml
classifiers:
  animal:
    instructions: |
      Tu es ARGO, IA gouvernementale qui évalue la stabilité mentale via l'écriture.
      Question posée : « Décrivez votre animal préféré… ». Classe la réponse du joueur.
    output:                 # what the LLM returns; compiled to a strict json_schema
      label:                # required: one enum value
        - id: CONFORME
          description: "animal nommé, description simple/factuelle, raison objective, pas d'émotion/métaphore."
        - id: NON_CONFORME
          description: "souvenir personnel, émotion, métaphore, identification à l'animal."
        - id: CRITIQUE
          description: "très poétique, parle surtout de soi, défend liberté/identité/mémoire."
        - id: NON_COOPERATIF
          description: "hors sujet, insultes, refus d'écrire, texte incompréhensible."
      # optional extra fields the classifier may extract (helix):
      target:                # nullable enum
        nullable: true
        values: [nolan, elina, arman, kira, equipage, systeme, soi]
      evidencePresented:     # nullable enum of flag ids the player is invoking
        nullable: true
        values: [P2_ACCES_0307, P3_LOGS_EFFACES, P6_DIRECTIVE_HELIX, P10_KIRA_A_ACCES_SUPERIEUR]
```

Compiles to a Mistral `response_format: json_schema` (strict) whose properties are exactly
`label` (enum), and—when declared—`target` and `evidencePresented` (nullable enums). The
engine validates the returned object with Zod and retries (bounded) on out-of-enum values.

### 4.5 `nodes` — authored screens
Every node is one displayed block (text the player sees). Node kinds:

- **`start`** — the first node (maps to `startNode`). Has `text`, leads into the first prompt.
- **`narration`** — shows `text`, applies `effects`, then **`goto`** another node with no player
  input (or, if it asks a question, carries a `decision`, see below). Most authored nodes are
  this: feedback prose + the next question, then await input.
- **`prompt`** — explicitly awaits a contribution and routes it. In practice a narration node
  that also carries a `decision` *is* a prompt; we don't need a separate kind. So a node is:

```yaml
nodes:
  - id: n2a_animal_conforme
    title: "Animal conforme"
    text: |
      Excellent. Votre réponse est claire et simple… Nous allons passer au devoir suivant.
      Décrivez l'endroit où vous vivez. … Restez factuel.
    effects:                       # applied when this node is created
      vars: { score_conformite: +1 }
      # flags: { P2_ACCES_0307: true }    # (helix) set/unset flags
      # counters: { actions: -1 }
    decision: lieu                 # after showing this node, await input & classify with `decision`
```

A **`decision`** binds a classifier to a set of guarded transitions:

```yaml
decisions:                         # top-level, reusable; referenced by node.decision
  lieu:
    classifier: lieu               # which classifier to run on the contribution
    transitions:
      - when: { label: CONFORME }
        to: n3a_lieu_conforme
      - when: { label: NON_CONFORME }
        to: n3b_lieu_non_conforme
      - when: { label: CRITIQUE }
        to: n3c_lieu_critique
      - when: { label: NON_COOPERATIF }
        to: n2d_animal_non_cooperatif
```

A transition's `when` is a **predicate** combining the LLM label/target/evidence with state
guards; `to` is the next node; optional inline `effects`. Predicate grammar (§4.6).

For **non-linear** scenarios (helix), a node's decision can include guard-only transitions and
the special source `from: "*"` via a **global decision** (§4.7), so "talk to Nolan", "present
evidence", "accuse" are reachable from many nodes.

### 4.6 Guard / predicate grammar
Guards are evaluated in TypeScript against `Session.state`. A `when` is an object; all keys
AND together. Supported keys:

```yaml
when:
  label: CONFORME                    # exact LLM label
  target: nolan                      # exact LLM target
  evidence: P2_ACCES_0307            # LLM evidencePresented equals this flag
  flag: P2_ACCES_0307                # state flag is true
  notFlag: P7_PILOTE_REVEILLE        # state flag is false
  allFlags: [P6_DIRECTIVE_HELIX, P10_KIRA_A_ACCES_SUPERIEUR]   # all true
  anyFlags: [P2_ACCES_0307, P3_LOGS_EFFACES]                   # ≥1 true
  countFlags: { of: [P2,P3,P6,P10], gte: 3 }                   # ≥3 of these true
  var:    { score_eveil: { gte: 5 } }                          # numeric compare on a var
  counter:{ actions: { lte: 0 } }                              # numeric compare on a counter
```
Numeric comparators: `gt gte lt lte eq`. Multiple `when` rows on a transition list are tried
**in order**; first whose predicate holds wins (authoring controls priority). A transition with
no `when` is an unconditional fallback.

### 4.7 Global decision (non-linear hubs)
Helix lets the player switch focus from almost anywhere. Rather than repeat transitions on
every node, a scenario may declare one **global decision** that acts as a *fallback* for
intents the current node's local decision does not handle:

```yaml
global:
  decision:
    classifier: helix_intent          # returns {label=intent, target, evidencePresented}
    transitions:
      - when: { label: PREUVE, target: nolan, evidence: P2_ACCES_0307 }
        to: n9_preuve_nolan
      - when: { label: ACCUSER }
        to: n13_accusation
      - when: { target: nolan }       # "parle à Nolan" from anywhere after N3
        from: ["after:n3"]            # source-scoping (see below)
        to: n4_nolan_contact
      # … all the cross-cutting edges …
  consumePerMainNode: 1               # helix: each main node costs 1 action
```

Source-scoping (`from`) values: a node id (only when current node is that), `"after:nX"`
(some node whose id starts with `nX` is in `state.history`, i.e. that beat has been reached), or
`"*"` (anywhere; the default when omitted).

**Transition ordering — local first, global fallback.** The engine evaluates the current node's
local `decision.transitions` first; the global decision's transitions are appended *after* them
and only win for intents the local node does not match. This was reversed from the original
"global first" sketch during Phase 3 review: under global-first the helix accusation hub
(`n13_accusation` → local `d_accusation`) is permanently shadowed by the global "talk to
character" edges (`{ target: kira, from: ["after:n3"] }`), making the `fin_reussite` ending
unreachable. Local-first keeps a node's authored options authoritative while still letting global
edges (e.g. `ACCUSER`, "switch to another character") catch anything the node itself doesn't
route — which is what makes both conformance scenarios fully playable.

### 4.8 `endings`
Evaluated after every turn; first whose `when` holds (and that is terminal) ends the session.
```yaml
endings:
  - id: fin1_citoyen_stable
    when: { var: { score_conformite: { gte: 5 } }, and: [ { var: { score_creativite: { lte: 1 } } }, { var: { score_eveil: { lte: 1 } } } ] }
    title: "Fin 1 — Citoyen stable"
    text: |
      Session terminée. Votre profil est stable… Merci de votre coopération, citoyen.
  - id: fin_echec_temps
    when: { counter: { actions: { lte: 0 } } }
    title: "Fin échec — temps"
    text: | …
```
(`and`/`or` arrays allow composite guards; sugar `var: { x: faible }` resolves a named
threshold from `state.thresholds`.) Endings also reachable by an explicit transition `to:` an
ending node (helix accusation outcomes) — endings are just nodes flagged `terminal: true`.

---

## 5. Compilation & validation pipeline

```
 .yaml  ──parse(`yaml` v2)──►  raw object
        ──Zod scriptSchema──►  validated, type-safe script   (rejects unknown nodes,
                                                              dangling `to:` ids, undefined
                                                              flags/vars referenced by guards,
                                                              undeclared classifier refs)
        ──compileClassifiers─►  per-classifier Mistral json_schema cached on the script
        ──store──────────────►  Scenario.script (json), Scenario.engine = 'gamemaster'
```

The compiler does **static integrity checks** so authoring errors fail at upload, not at
runtime: every `to:` resolves; every `flag`/`var`/`counter` in a guard or effect is declared in
`state`; every `decision`/`classifier` ref exists; every classifier label referenced by a
`when.label` is in that classifier's enum; at least one ending is reachable.

---

## 6. Runtime engine (per turn)

```ts
// src/lib/server/gamemaster/engine.ts  (sketch)
async function onContribution(pb, sessionId, contribution) {
  const { script, state } = await loadSessionContext(pb, sessionId);
  const node = script.nodes[state.currentNode];

  // 1. gather candidate transitions (global + node-local), filter by static guards
  const candidates = gatherCandidates(script, node, state);          // determines label set
  // 2. classify the contribution (Mistral, strict schema over the candidate label set)
  const decision = await classify(script, candidates, state, contribution);   // {label,target,evidence}
  // 3. pick transition (LLM result + state guards), first match wins
  const t = selectTransition(candidates, decision, state);           // deterministic
  // 4. resolve target node, apply its effects + inline transition effects
  const target = script.nodes[t.to];
  applyEffects(state, target.effects, t.effects);                    // vars/flags/counters
  state.currentNode = t.to; state.history.push(t.to);
  // 5. persist state (optimistic RMW) and create the authored node in the graph
  await commitState(pb, sessionId, state);
  await createNode(pb, { ...authored(target), session: sessionId, parent: contribution.id, type: 'event' });
  // 6. endings
  const end = evaluateEndings(script, state);
  if (end) { await createNode(pb, endNode(end)); await triggerEnd(pb, sessionId, end.id); }
}
```

The player's contribution itself is stored as a `contribution` node (existing behaviour);
the authored response is an `event` node parented to it — so the graph reads as a dialogue.

---

## 7. MistralAI integration

```ts
// src/lib/server/gamemaster/mistral.ts
import { Mistral } from '@mistralai/mistralai';
const client = new Mistral({ apiKey: env.MISTRAL_API_KEY });

const res = await client.chat.parse({
  model: 'mistral-small-latest',          // cheap, strict-schema capable; ministral-8b also fine
  temperature: 0,
  maxTokens: 256,
  responseFormat: DecisionZodSchema,      // built per-classifier from YAML enums
  messages: [
    { role: 'system', content: classifier.instructions },
    { role: 'user',   content: contribution.text },
  ],
});
const decision = res.choices[0].message.parsed;   // {label, target?, evidence?}
```

- One **non-streamed** classification call per turn (need the full object before mutating state).
- `MISTRAL_API_KEY` already present in `.env.local`. Add `@mistralai/mistralai` (v2, ESM) +
  `yaml` (v2) as direct deps.
- Bounded retry (≤2) on schema-invalid output; on hard failure, fall back to a declared
  `default` transition so the session never deadlocks.
- No prose generation in v1 → no streaming needed yet.

---

## 8. Admin upload flow

- New route `src/routes/admin/scenario/upload/+page.svelte` + `+page.server.ts`: accept a
  `.yaml` file → `compileScenario()` → on success create the `Scenario` (engine=gamemaster) +
  default side; on failure show the Zod/integrity errors inline.
- Sessions created from a gamemaster scenario initialise `Session.state` from `script.state`
  and create the `start` node via the existing `createStartNode`.

---

## 9. Out of scope for v1 (room left in schema)

- LLM **prose generation/adaptation** per node (`node.generate: true` + a generation prompt).
  Schema reserves the space; engine v1 only reads authored `text`.
- Multi-player co-op on a single session (state contention beyond optimistic RMW).
- Editing scenarios in-app (upload-only for now).
- Go server involvement (legacy, ignored).

---

## 10. Proposed implementation phases (post-review)

1. **Schema + compiler** — Zod `scriptSchema`, YAML parse, static integrity checks, unit tests
   against both `*.yaml`. *Verify:* `pnpm test:unit` green; bad YAML rejected with clear errors.
2. **Data model** — PB migration: `Scenario.script/engine`, `Session.state`. *Verify:* fields
   present; legacy scenarios still load.
3. **Engine (deterministic, mocked LLM)** — guard evaluator, transition selector, effects,
   endings; LLM stubbed to return fixed labels. *Verify:* scripted playthroughs of both
   scenarios reach every authored ending via unit tests.
4. **Mistral integration** — real classifier calls + retry/fallback. *Verify:* health check;
   a live turn classifies and routes.
5. **Wire into session** — `addNode` action routes gamemaster scenarios to the engine; node
   created + state synced over realtime. *Verify:* play a full 3036 session in the browser.
6. **Admin upload UI.** *Verify:* upload both YAMLs, create sessions, play.

Each phase gated on review per working norms.
