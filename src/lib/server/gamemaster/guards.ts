// Deterministic predicate (`when`) evaluation for the LLM-gamemaster engine.
// See docs/llm-gamemaster-design.md §4.6–4.7. A predicate combines the LLM classification
// (label/target/evidence) with guards over the per-session runtime state; all present keys
// AND together. Used both for transition selection and for ending evaluation.

import type { NumCompare, Predicate, Script } from '$lib/scenario/script.schema';
import type { LlmDecision, RuntimeState } from './engine';

export function evalPredicate(
	pred: Predicate | undefined,
	state: RuntimeState,
	decision: LlmDecision,
	script: Script
): boolean {
	if (!pred) return true; // no `when` ⇒ unconditional fallback
	if (pred.never) return false; // only reachable through an explicit `ending:`/`to:` reference

	if (pred.from && !matchesFrom(pred.from, state)) return false;

	// --- LLM classification ---
	if (pred.label !== undefined && decision.label !== pred.label) return false;
	if (pred.target !== undefined && (decision.target ?? null) !== pred.target) return false;
	if (pred.evidence !== undefined && (decision.evidencePresented ?? null) !== pred.evidence)
		return false;

	// --- state flags ---
	if (pred.flag !== undefined && state.flags[pred.flag] !== true) return false;
	if (pred.notFlag !== undefined && state.flags[pred.notFlag] === true) return false;
	if (pred.allFlags && !pred.allFlags.every((f) => state.flags[f])) return false;
	if (pred.anyFlags && !pred.anyFlags.some((f) => state.flags[f])) return false;
	if (pred.countFlags) {
		const count = pred.countFlags.of.filter((f) => state.flags[f]).length;
		if (!numCompare(count, pred.countFlags)) return false;
	}

	// --- numeric vars / counters ---
	if (pred.var && !matchCompareMap(pred.var, state.vars, script)) return false;
	if (pred.counter && !matchCompareMap(pred.counter, state.counters, script)) return false;

	// --- composite ---
	if (pred.and && !pred.and.every((sub) => evalPredicate(sub, state, decision, script)))
		return false;
	if (pred.or && pred.or.length && !pred.or.some((sub) => evalPredicate(sub, state, decision, script)))
		return false;

	return true;
}

// `from` is satisfied if ANY entry matches (see §4.7).
function matchesFrom(from: string[], state: RuntimeState): boolean {
	return from.some((f) => {
		if (f === '*') return true;
		if (f.startsWith('after:')) {
			const token = f.slice('after:'.length);
			return state.history.some((id) => id === token || id.startsWith(token));
		}
		return state.currentNode === f; // a bare node id matches only when it is the current node
	});
}

function numCompare(value: number, c: NumCompare): boolean {
	if (c.gt !== undefined && !(value > c.gt)) return false;
	if (c.gte !== undefined && !(value >= c.gte)) return false;
	if (c.lt !== undefined && !(value < c.lt)) return false;
	if (c.lte !== undefined && !(value <= c.lte)) return false;
	if (c.eq !== undefined && !(value === c.eq)) return false;
	return true;
}

// Each entry compares a var/counter against a comparator object or a named threshold (string sugar).
function matchCompareMap(
	map: Record<string, NumCompare | string>,
	values: Record<string, number>,
	script: Script
): boolean {
	for (const [name, cmp] of Object.entries(map)) {
		const c = typeof cmp === 'string' ? script.state.thresholds[cmp] : cmp;
		if (!c) return false; // unknown threshold — the compiler should have rejected this
		if (!numCompare(values[name] ?? 0, c)) return false;
	}
	return true;
}
