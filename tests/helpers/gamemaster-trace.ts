// ---------------------------------------------------------------------------
// Live gamemaster run TRACER
// ---------------------------------------------------------------------------
// Plays a compiled scenario through the REAL Mistral classifier and records a complete,
// structured trace of every turn: the player's message, the AI's classification (label / target /
// evidence), WHY the engine routed where it did (every candidate transition + which one won),
// the authored narration shown back to the player, and the exact state change.
//
// Design intent: the deterministic engine (src/lib/server/gamemaster/engine.ts) is reused as-is —
// this module never re-implements routing. It calls the engine's own `gatherCandidates`,
// `evalPredicate` and `step`, so the trace is a faithful mirror of what runs in production
// (src/lib/server/gamemaster/turn.ts). See docs/gamemaster-live-testing.md for the full picture.

import type { CompiledScript } from '../../src/lib/scenario/compile';
import type { Classifier, Decision, Transition } from '../../src/lib/scenario/script.schema';
import { classify } from '../../src/lib/server/gamemaster/mistral';
import {
	initState,
	step,
	gatherCandidates,
	type RuntimeState,
	type LlmDecision
} from '../../src/lib/server/gamemaster/engine';
import { evalPredicate } from '../../src/lib/server/gamemaster/guards';

// What the caller specifies for each turn: the prose a human would type, and (optionally) the
// classification we EXPECT the AI to produce, so the report can score accuracy.
export interface TurnSpec {
	message: string;
	expect?: { label?: string | null; target?: string | null; evidence?: string | null };
	note?: string; // optional authoring note shown in the report ("why this message")
}

// One candidate transition the engine considered this turn, and whether its guard held.
export interface CandidateTrace {
	source: 'node-local' | 'global';
	to: string;
	when: Transition['when'];
	matched: boolean;
	winner: boolean;
}

export interface StateDiff {
	varsChanged: { key: string; from: number; to: number }[];
	flagsSet: string[];
	flagsCleared: string[];
	countersChanged: { key: string; from: number; to: number }[];
}

export interface TurnTrace {
	index: number;
	player: string;
	note?: string;
	fromNode: string;
	fromNodeTitle: string;
	classifier: { id: string | undefined; source: 'node-local' | 'global' | 'none' };
	ai: LlmDecision;
	aiLatencyMs: number;
	fallback: boolean; // Mistral hard-failed → empty decision {}
	expected?: TurnSpec['expect'];
	match: { label?: boolean; target?: boolean; evidence?: boolean };
	candidates: CandidateTrace[];
	chosen: { to: string; source: 'node-local' | 'global' } | null; // null ⇒ stuck (no guard held)
	createdNodes: { id: string; title: string; text: string }[]; // authored narration shown to player
	toNode: string;
	toNodeTitle: string;
	reachedEnding: boolean;
	stateAfter: { vars: Record<string, number>; flags: Record<string, boolean>; counters: Record<string, number> };
	diff: StateDiff;
	warnings: string[];
}

export interface RunMeta {
	scenario: string; // file stem, e.g. "3036"
	title: string; // human title
	objective: string; // 1-2 sentences: what this run is trying to demonstrate
	expectedEnding: string; // ending id we aim for
	startedAtISO: string; // timestamp (passed in; Date is fine in vitest)
}

export interface RunTrace extends RunMeta {
	model: string;
	turns: TurnTrace[];
	endingId: string | null;
	endingTitle: string | null;
	verdict: 'PASS' | 'FAIL';
	finalState: RuntimeState;
	totalLatencyMs: number;
}

const EMPTY = '—';

function nodeTitle(script: CompiledScript, id: string): string {
	const n = script.nodes.find((x) => x.id === id);
	if (n) return n.title ?? id;
	const e = script.endings.find((x) => x.id === id);
	return e ? e.title : id;
}

function localDecisionOf(script: CompiledScript, state: RuntimeState): Decision | undefined {
	const node = script.nodes.find((n) => n.id === state.currentNode);
	const dec = node?.decision;
	if (!dec) return undefined;
	return typeof dec === 'string' ? script.decisions[dec] : dec;
}

function snapshot(state: RuntimeState) {
	return {
		vars: { ...state.vars },
		flags: { ...state.flags },
		counters: { ...state.counters }
	};
}

function diffState(
	before: ReturnType<typeof snapshot>,
	after: ReturnType<typeof snapshot>
): StateDiff {
	const varsChanged = Object.keys(after.vars)
		.filter((k) => after.vars[k] !== before.vars[k])
		.map((k) => ({ key: k, from: before.vars[k], to: after.vars[k] }));
	const countersChanged = Object.keys(after.counters)
		.filter((k) => after.counters[k] !== before.counters[k])
		.map((k) => ({ key: k, from: before.counters[k], to: after.counters[k] }));
	const flagsSet = Object.keys(after.flags).filter((k) => after.flags[k] && !before.flags[k]);
	const flagsCleared = Object.keys(after.flags).filter((k) => !after.flags[k] && before.flags[k]);
	return { varsChanged, flagsSet, flagsCleared, countersChanged };
}

// Run one full live playthrough and return the complete trace.
export async function tracePlaythrough(
	script: CompiledScript,
	meta: RunMeta,
	specs: TurnSpec[]
): Promise<RunTrace> {
	const state = initState(script);
	const turns: TurnTrace[] = [];
	let totalLatency = 0;

	for (let i = 0; i < specs.length; i++) {
		if (state.ended) break;
		const spec = specs[i];
		const fromNode = state.currentNode;
		const node = script.nodes.find((n) => n.id === fromNode);
		if (!node) break;

		// Which classifier does the engine run here? node-local decision first, else global fallback.
		const localDec = localDecisionOf(script, state);
		const classifierSource: 'node-local' | 'global' | 'none' = localDec
			? 'node-local'
			: script.global
				? 'global'
				: 'none';
		const classifierId = localDec?.classifier ?? script.global?.decision.classifier;
		const classifier: Classifier | undefined = classifierId
			? script.classifiers[classifierId]
			: undefined;

		// --- real Mistral classification (timed) ---
		const t0 = performance.now();
		const ai: LlmDecision = classifier ? await classify(classifier, spec.message) : {};
		const latency = performance.now() - t0;
		totalLatency += latency;
		const fallback = classifier != null && Object.keys(ai).length === 0;

		// --- routing introspection: replay the engine's own candidate gathering + guard eval ---
		const allCandidates = gatherCandidates(script, node);
		const localCount = localDec?.transitions.length ?? 0;
		let winnerIdx = -1;
		const candidates: CandidateTrace[] = allCandidates.map((t, idx) => {
			const matched = evalPredicate(t.when, state, ai, script);
			if (matched && winnerIdx === -1) winnerIdx = idx;
			return {
				source: idx < localCount ? 'node-local' : 'global',
				to: t.to,
				when: t.when,
				matched,
				winner: false
			};
		});
		if (winnerIdx >= 0) candidates[winnerIdx].winner = true;
		const chosen =
			winnerIdx >= 0
				? { to: allCandidates[winnerIdx].to, source: candidates[winnerIdx].source }
				: null;

		// --- actually advance the engine ---
		const before = snapshot(state);
		const result = step(script, state, ai);
		const after = snapshot(state);
		const diff = diffState(before, after);

		// --- expectation scoring ---
		const exp = spec.expect;
		const match: TurnTrace['match'] = {};
		if (exp) {
			if (exp.label !== undefined) match.label = ai.label === exp.label;
			if (exp.target !== undefined) match.target = (ai.target ?? null) === exp.target;
			if (exp.evidence !== undefined)
				match.evidence = (ai.evidencePresented ?? null) === exp.evidence;
		}

		// --- warnings ---
		const warnings: string[] = [];
		if (fallback) warnings.push('Mistral hard-failed; classification fell back to empty {}.');
		if (!chosen) warnings.push(`No transition matched at "${fromNode}" — the turn made no move (stuck).`);
		if (chosen && state.currentNode === fromNode && !state.ended)
			warnings.push(`Self-loop: routed back to the same node "${fromNode}" (no forward progress).`);
		if (match.label === false)
			warnings.push(`Label mismatch: expected "${exp?.label}", got "${ai.label}".`);
		if (match.target === false)
			warnings.push(`Target mismatch: expected "${exp?.target}", got "${ai.target ?? null}".`);
		if (match.evidence === false)
			warnings.push(`Evidence mismatch: expected "${exp?.evidence}", got "${ai.evidencePresented ?? null}".`);

		turns.push({
			index: i,
			player: spec.message,
			note: spec.note,
			fromNode,
			fromNodeTitle: nodeTitle(script, fromNode),
			classifier: { id: classifierId, source: classifierSource },
			ai,
			aiLatencyMs: Math.round(latency),
			fallback,
			expected: exp,
			match,
			candidates,
			chosen,
			createdNodes: result.created.map((n) => ({
				id: n.id,
				title: n.title ?? n.id,
				text: n.text
			})),
			toNode: state.currentNode,
			toNodeTitle: nodeTitle(script, state.currentNode),
			reachedEnding: state.ended != null, // we break at loop top once ended ⇒ true only on the final turn
			stateAfter: after,
			diff,
			warnings
		});
	}

	const endingId = state.ended;
	return {
		...meta,
		model: 'mistral-small-latest',
		turns,
		endingId,
		endingTitle: endingId ? nodeTitle(script, endingId) : null,
		verdict: endingId === meta.expectedEnding ? 'PASS' : 'FAIL',
		finalState: state,
		totalLatencyMs: Math.round(totalLatency)
	};
}

export { EMPTY };
