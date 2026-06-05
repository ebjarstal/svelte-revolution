// Deterministic runtime engine for LLM-gamemaster scenarios.
// See docs/llm-gamemaster-design.md §6. The LLM only produces a constrained classification
// (`LlmDecision`); everything here — transition selection, guards, effects, endings — is
// deterministic TypeScript with no PocketBase or Mistral dependency, so it is fully unit-testable.

import type {
	Decision,
	Effects,
	Ending,
	ScenarioNode,
	Script,
	Transition
} from '$lib/scenario/script.schema';
import { evalPredicate } from './guards';

// What the LLM classifier returns for one contribution (the only non-deterministic input).
export interface LlmDecision {
	label?: string;
	target?: string | null;
	evidencePresented?: string | null;
}

// Per-session runtime state, initialised from `script.state` (see §3). Distinct from the
// authored `ScenarioState`: flags are resolved to a boolean map and navigation fields are added.
export interface RuntimeState {
	vars: Record<string, number>;
	flags: Record<string, boolean>;
	counters: Record<string, number>;
	currentNode: string;
	history: string[];
	ended: string | null; // ending id once the session has terminated
}

export interface StepResult {
	created: ScenarioNode[]; // authored nodes entered this turn, in display order
	ending: Ending | null; // set once the session terminates
}

const EMPTY_DECISION: LlmDecision = {};

// Initialise state from the script and auto-advance from `start` through any `goto` chain to
// the first node that awaits input (e.g. helix `start` → `n1_reveil`). No action is consumed.
export function initState(script: Script): RuntimeState {
	const state: RuntimeState = {
		vars: { ...script.state.vars },
		flags: initFlags(script.state.flags),
		counters: { ...script.state.counters },
		currentNode: 'start',
		history: [],
		ended: null
	};
	enter(script, state, 'start', undefined, false);
	return state;
}

function initFlags(flags: Script['state']['flags']): Record<string, boolean> {
	if (Array.isArray(flags)) return Object.fromEntries(flags.map((f) => [f, false]));
	return { ...flags };
}

// Advance one turn given the LLM's classification of the player's contribution.
export function step(script: Script, state: RuntimeState, decision: LlmDecision): StepResult {
	if (state.ended) return { created: [], ending: endingById(script, state.ended) };

	const node = nodeById(script, state.currentNode);
	if (!node) throw new Error(`gamemaster engine: current node '${state.currentNode}' not found`);

	const transitions = gatherCandidates(script, node);
	const t = selectTransition(transitions, state, decision, script);
	if (!t) return { created: [], ending: null }; // no transition matched; caller handles fallback (§7)

	const res = enter(script, state, t.to, t.effects, true);
	if (state.ended) return res; // ended via a terminal/ending node or a direct `to:` ending

	const ending = evaluateEndings(script, state);
	if (ending) state.ended = ending.id;
	return { created: res.created, ending };
}

// Local decision first, global decision appended as a fallback (§4.7 — local-first).
export function gatherCandidates(script: Script, node: ScenarioNode): Transition[] {
	const transitions: Transition[] = [];
	const local = resolveDecision(script, node.decision);
	if (local) transitions.push(...local.transitions);
	if (script.global) transitions.push(...script.global.decision.transitions);
	return transitions;
}

// First transition whose `when` predicate holds wins (authoring controls priority).
export function selectTransition(
	transitions: Transition[],
	state: RuntimeState,
	decision: LlmDecision,
	script: Script
): Transition | undefined {
	return transitions.find((t) => evalPredicate(t.when, state, decision, script));
}

// vars/counters are additive (deltas); flags are assigned. Multiple effect sets apply in order.
export function applyEffects(state: RuntimeState, ...effectsList: (Effects | undefined)[]): void {
	for (const effects of effectsList) {
		if (!effects) continue;
		for (const [k, delta] of Object.entries(effects.vars ?? {})) {
			state.vars[k] = (state.vars[k] ?? 0) + delta;
		}
		for (const [k, delta] of Object.entries(effects.counters ?? {})) {
			state.counters[k] = (state.counters[k] ?? 0) + delta;
		}
		for (const [k, value] of Object.entries(effects.flags ?? {})) {
			state.flags[k] = value;
		}
	}
}

// First ending (in authored order) whose `when` holds. `never: true` endings are reachable
// only via an explicit `ending:`/`to:` reference, never by predicate.
export function evaluateEndings(script: Script, state: RuntimeState): Ending | null {
	for (const e of script.endings) {
		if (e.when.never) continue;
		if (evalPredicate(e.when, state, EMPTY_DECISION, script)) return e;
	}
	return null;
}

// --- internals -------------------------------------------------------------

// Enter `toId`, applying its effects (and, on the first hop, the transition's inline effects and
// the action cost), then follow any `goto` chain until a node that awaits input or terminates.
function enter(
	script: Script,
	state: RuntimeState,
	toId: string,
	inlineEffects: Effects | undefined,
	consume: boolean
): StepResult {
	const created: ScenarioNode[] = [];
	let id = toId;
	let firstHop = true;

	while (true) {
		const directEnding = endingById(script, id);
		if (directEnding) {
			// A transition (or goto) pointed straight at an ending id, e.g. 3036 `to: fin5_…`.
			state.history.push(id);
			state.ended = directEnding.id;
			break;
		}

		const node = nodeById(script, id);
		if (!node) throw new Error(`gamemaster engine: '${id}' is neither a node nor an ending`);

		applyEffects(state, node.effects, firstHop ? inlineEffects : undefined);
		if (firstHop && consume) applyConsume(script, state, node);
		state.currentNode = id;
		state.history.push(id);
		created.push(node);
		firstHop = false;

		if (node.ending) {
			state.ended = node.ending;
			break;
		}
		if (node.terminal) break;
		if (node.goto) {
			id = node.goto;
			continue;
		}
		break; // awaits a player contribution (or is a scoring dead-end resolved by endings)
	}

	return { created, ending: state.ended ? endingById(script, state.ended) : null };
}

// Action cost of creating a node: an explicit per-node `consume` override, else the scenario's
// `consumePerMainNode` applied to every declared counter (helix: each main node costs 1 action).
function applyConsume(script: Script, state: RuntimeState, node: ScenarioNode): void {
	if (node.consume) {
		for (const [k, cost] of Object.entries(node.consume)) {
			state.counters[k] = (state.counters[k] ?? 0) - cost;
		}
		return;
	}
	const per = script.global?.consumePerMainNode;
	if (per == null) return;
	for (const k of Object.keys(state.counters)) state.counters[k] -= per;
}

function resolveDecision(script: Script, decision: ScenarioNode['decision']): Decision | undefined {
	if (!decision) return undefined;
	return typeof decision === 'string' ? script.decisions[decision] : decision;
}

function nodeById(script: Script, id: string): ScenarioNode | undefined {
	return script.nodes.find((n) => n.id === id);
}

function endingById(script: Script, id: string): Ending | null {
	return script.endings.find((e) => e.id === id) ?? null;
}
