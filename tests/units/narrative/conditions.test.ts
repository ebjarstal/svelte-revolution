import { describe, expect, test } from 'vitest';
import { evaluate, type EvalContext } from '../../../src/lib/narrative/conditions';
import type { Condition, ScenarioRules, SessionState } from '../../../src/lib/narrative/types';

interface CtxOverrides {
	state?: Partial<SessionState>;
	intent?: string | null;
	classification?: string | null;
	target?: string | null;
	rules?: ScenarioRules;
}

function ctx(overrides: CtxOverrides = {}): EvalContext {
	const state: SessionState = {
		current_node: 'N0',
		visited_nodes: [],
		evidences: [],
		scores: {},
		warnings: 0,
		actions_left: null,
		last_intent: null,
		last_classification: null,
		ended_with: null,
		...(overrides.state ?? {})
	};
	return {
		state,
		intent: overrides.intent ?? null,
		classification: overrides.classification ?? null,
		target: overrides.target ?? null,
		rules: overrides.rules ?? {}
	};
}

describe('conditions — leaf predicates', () => {
	test('condition undefined = vraie avec specificité 0', () => {
		expect(evaluate(undefined, ctx())).toEqual({ ok: true, matched: 0 });
	});

	test('from : matche si le noeud est dans visited_nodes', () => {
		const c: Condition = { from: 'N1' };
		expect(evaluate(c, ctx({ state: { visited_nodes: ['N1'] } })).ok).toBe(true);
		expect(evaluate(c, ctx({ state: { visited_nodes: ['N0'] } })).ok).toBe(false);
	});

	test('last : matche si current_node ∈ liste', () => {
		const c: Condition = { last: ['N1', 'N2'] };
		expect(evaluate(c, ctx({ state: { current_node: 'N1' } })).ok).toBe(true);
		expect(evaluate(c, ctx({ state: { current_node: 'N3' } })).ok).toBe(false);
	});

	test('visited : matche si tous les noeuds sont visités', () => {
		const c: Condition = { visited: ['N1', 'N2'] };
		expect(evaluate(c, ctx({ state: { visited_nodes: ['N1', 'N2', 'N3'] } })).ok).toBe(true);
		expect(evaluate(c, ctx({ state: { visited_nodes: ['N1'] } })).ok).toBe(false);
	});

	test('intent_in : matche si intent ∈ labels', () => {
		const c: Condition = { intent_in: ['COMPRENDRE', 'SYSTEME'] };
		expect(evaluate(c, ctx({ intent: 'SYSTEME' })).ok).toBe(true);
		expect(evaluate(c, ctx({ intent: 'OBSERVER' })).ok).toBe(false);
		expect(evaluate(c, ctx()).ok).toBe(false);
	});

	test('target : matche si target === characterId', () => {
		expect(evaluate({ target: 'kira' }, ctx({ target: 'kira' })).ok).toBe(true);
		expect(evaluate({ target: 'kira' }, ctx({ target: 'nolan' })).ok).toBe(false);
	});

	test('classification_is : matche si classification === label', () => {
		expect(evaluate({ classification_is: 'CONFORME' }, ctx({ classification: 'CONFORME' })).ok).toBe(true);
		expect(evaluate({ classification_is: 'CONFORME' }, ctx({ classification: 'CRITIQUE' })).ok).toBe(false);
	});

	test('has / has_any / has_all', () => {
		const s = { evidences: ['P1', 'P2', 'P3'] };
		expect(evaluate({ has: 'P1' }, ctx({ state: s })).ok).toBe(true);
		expect(evaluate({ has: 'P9' }, ctx({ state: s })).ok).toBe(false);
		expect(evaluate({ has_any: ['P9', 'P2'] }, ctx({ state: s })).ok).toBe(true);
		expect(evaluate({ has_any: ['P9'] }, ctx({ state: s })).ok).toBe(false);
		expect(evaluate({ has_all: ['P1', 'P2'] }, ctx({ state: s })).ok).toBe(true);
		expect(evaluate({ has_all: ['P1', 'P9'] }, ctx({ state: s })).ok).toBe(false);
	});

	test('has_count_among gte / lte', () => {
		const s = { evidences: ['P2', 'P3', 'P10'] };
		const list = ['P2', 'P3', 'P6', 'P10'];
		expect(evaluate({ has_count_among: { ids: list, gte: 3 } }, ctx({ state: s })).ok).toBe(true);
		expect(evaluate({ has_count_among: { ids: list, gte: 4 } }, ctx({ state: s })).ok).toBe(false);
		expect(evaluate({ has_count_among: { ids: list, lte: 1 } }, ctx({ state: s })).ok).toBe(false);
		expect(evaluate({ has_count_among: { ids: list, lte: 3 } }, ctx({ state: s })).ok).toBe(true);
	});

	test('actions_left avec lte: 0', () => {
		expect(evaluate({ actions_left: { lte: 0 } }, ctx({ state: { actions_left: 0 } })).ok).toBe(true);
		expect(evaluate({ actions_left: { lte: 0 } }, ctx({ state: { actions_left: 1 } })).ok).toBe(false);
		expect(evaluate({ actions_left: { lte: 0 } }, ctx({ state: { actions_left: null } })).ok).toBe(false);
	});

	test('warnings : comparateur', () => {
		expect(evaluate({ warnings: { gte: 2 } }, ctx({ state: { warnings: 2 } })).ok).toBe(true);
		expect(evaluate({ warnings: { gte: 2 } }, ctx({ state: { warnings: 1 } })).ok).toBe(false);
	});

	test('score_level avec score_caps', () => {
		const rules = { score_caps: { eveil: 10 } };
		expect(evaluate({ score_level: { axis: 'eveil', level: 'faible' } }, ctx({ state: { scores: { eveil: 2 } }, rules })).ok).toBe(true);
		expect(evaluate({ score_level: { axis: 'eveil', level: 'moyen' } }, ctx({ state: { scores: { eveil: 5 } }, rules })).ok).toBe(true);
		expect(evaluate({ score_level: { axis: 'eveil', level: 'eleve' } }, ctx({ state: { scores: { eveil: 7 } }, rules })).ok).toBe(true);
		expect(evaluate({ score_level: { axis: 'eveil', level: 'eleve' } }, ctx({ state: { scores: { eveil: 6 } }, rules })).ok).toBe(false);
	});
});

describe('conditions — combinators + specificity', () => {
	test('all : tous doivent passer, spécificité = somme', () => {
		const c: Condition = { all: [{ from: 'N1' }, { intent_in: ['X'] }] };
		const ok = evaluate(c, ctx({ state: { visited_nodes: ['N1'] }, intent: 'X' }));
		expect(ok).toEqual({ ok: true, matched: 2 });
		const ko = evaluate(c, ctx({ state: { visited_nodes: ['N1'] }, intent: 'Y' }));
		expect(ko.ok).toBe(false);
	});

	test('any : prend la branche gagnante avec la plus haute spécificité', () => {
		const c: Condition = {
			any: [{ from: 'N1' }, { all: [{ from: 'N2' }, { target: 'kira' }] }]
		};
		// N2 + kira → branche 2 vaut 2
		const r = evaluate(c, ctx({ state: { visited_nodes: ['N1', 'N2'] }, target: 'kira' }));
		expect(r.ok).toBe(true);
		expect(r.matched).toBe(2);
	});

	test('implicit AND : prédicats au top-level d\'un objet', () => {
		const c: Condition = { from: 'N1', intent_in: ['X'] };
		const r = evaluate(c, ctx({ state: { visited_nodes: ['N1'] }, intent: 'X' }));
		expect(r).toEqual({ ok: true, matched: 2 });
	});

	test('not : inverse la sortie ok', () => {
		expect(evaluate({ not: { from: 'N1' } }, ctx()).ok).toBe(true);
		expect(evaluate({ not: { from: 'N1' } }, ctx({ state: { visited_nodes: ['N1'] } })).ok).toBe(false);
	});
});
