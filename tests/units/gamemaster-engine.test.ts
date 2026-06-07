import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileScenario } from '../../src/lib/scenario/compile';
import {
	initState,
	step,
	type LlmDecision,
	type RuntimeState
} from '../../src/lib/server/gamemaster/engine';

const read = (name: string) =>
	readFileSync(new URL(`../../scenarios/${name}`, import.meta.url), 'utf-8');

const scenario3036 = compileScenario(read('3036.yaml'));
const helix = compileScenario(read('helix.yaml'));

// Drive a scripted playthrough: feed each fixed LLM decision in turn until the session ends.
function play(
	script: ReturnType<typeof compileScenario>,
	decisions: LlmDecision[]
): { state: RuntimeState; endingId: string | null } {
	const state = initState(script);
	for (const d of decisions) {
		if (state.ended) break;
		step(script, state, d);
	}
	return { state, endingId: state.ended };
}

const L = (label: string): LlmDecision => ({ label });

describe('gamemaster engine — 3036 playthroughs reach every ending', () => {
	// label sequences from `start` (d_pret) to each terminal ending.
	const paths: Record<string, string[]> = {
		fin1_citoyen_stable: ['ACCEPTE', 'CONFORME', 'CONFORME', 'CHOIX_A', 'CONFORME', 'CONFORME', 'CONFORME'],
		fin2_surveillance_legere: ['ACCEPTE', 'NON_CONFORME', 'NON_CONFORME', 'CHOIX_A', 'CONFORME', 'CONFORME', 'CONFORME'],
		fin3_reeducation_expressive: ['ACCEPTE', 'NON_CONFORME', 'NON_CONFORME', 'REFUS', 'NON_CONFORME', 'NON_CONFORME', 'CREATIF'],
		fin4_eveille: ['ACCEPTE', 'CRITIQUE', 'CRITIQUE', 'REFUS', 'CRITIQUE', 'CRITIQUE', 'EVEIL'],
		fin5_session_interrompue: ['ACCEPTE', 'NON_COOPERATIF', 'NON_COOPERATIF']
	};

	for (const [endingId, labels] of Object.entries(paths)) {
		it(`reaches ${endingId}`, () => {
			const { endingId: reached } = play(scenario3036, labels.map(L));
			expect(reached).toBe(endingId);
		});
	}

	it('covers all authored 3036 endings', () => {
		const reached = new Set(Object.values(paths).map((labels) => play(scenario3036, labels.map(L)).endingId));
		expect(reached).toEqual(new Set(scenario3036.endings.map((e) => e.id)));
	});

	it('accumulates effects deterministically along the éveil path', () => {
		const { state } = play(scenario3036, paths.fin4_eveille.map(L));
		expect(state.flags.final).toBe(true);
		expect(state.vars.score_eveil).toBeGreaterThanOrEqual(5); // "eleve" band
	});
});

describe('gamemaster engine — helix playthroughs reach every ending', () => {
	it('reaches fin_echec_temps when the action counter is exhausted', () => {
		// "OBSERVER" routes to n8 every turn (local d_n1 / global fallback), each costing 1 action.
		const { state, endingId } = play(helix, Array(18).fill(L('OBSERVER')));
		expect(endingId).toBe('fin_echec_temps');
		expect(state.counters.actions).toBeLessThanOrEqual(0);
	});

	it('reaches fin_echec_accusation when accusing without proof', () => {
		// Accuse immediately (no investigation): ACCUSER → n13_accusation, then name Nolan.
		const { endingId } = play(helix, [L('ACCUSER'), { target: 'nolan' }]);
		expect(endingId).toBe('fin_echec_accusation');
	});

	it('reaches fin_reussite after gathering proof and accusing Kira', () => {
		const { state, endingId } = play(helix, [
			L('SYSTEME'), // n1 → n2_terminal
			L('LOGS'), // → n2_2_logs (P2, P3)
			L('ACCES'), // → n2_4_acces (P5)
			L('ACCES'), // → n2_5_acces_superieur (P10)
			L('EQUIPAGE'), // global fallback → n3_equipage
			{ target: 'kira' }, // d_corridor → n7_kira_contact
			{ evidencePresented: 'P6_DIRECTIVE_HELIX' }, // d_kira → n7_4_directive_helix (P6)
			L('ACCUSER'), // global fallback → n13_accusation
			{ target: 'kira' } // d_accusation (proof sufficient) → n13_5 → n14 → fin_reussite
		]);
		expect(endingId).toBe('fin_reussite');
		expect(state.flags.P6_DIRECTIVE_HELIX).toBe(true);
		expect(state.flags.P10_KIRA_A_ACCES_SUPERIEUR).toBe(true);
	});

	it('covers all authored helix endings', () => {
		const reached = new Set([
			play(helix, Array(18).fill(L('OBSERVER'))).endingId,
			play(helix, [L('ACCUSER'), { target: 'nolan' }]).endingId,
			play(helix, [
				L('SYSTEME'),
				L('LOGS'),
				L('ACCES'),
				L('ACCES'),
				L('EQUIPAGE'),
				{ target: 'kira' },
				{ evidencePresented: 'P6_DIRECTIVE_HELIX' },
				L('ACCUSER'),
				{ target: 'kira' }
			]).endingId
		]);
		expect(reached).toEqual(new Set(helix.endings.map((e) => e.id)));
	});
});

describe('gamemaster engine — local-first transition ordering', () => {
	it('lets a node-local decision win over a matching global edge', () => {
		// At n13_accusation, the local d_accusation routes "kira" with proof to the win path,
		// even though the global decision also has a `target: kira` edge (→ n7_kira_contact).
		const decisions: LlmDecision[] = [
			L('SYSTEME'),
			L('LOGS'),
			L('ACCES'),
			L('ACCES'),
			L('EQUIPAGE'),
			{ target: 'kira' },
			{ evidencePresented: 'P6_DIRECTIVE_HELIX' },
			L('ACCUSER')
		];
		const state = initState(helix);
		for (const d of decisions) step(helix, state, d);
		expect(state.currentNode).toBe('n13_accusation');

		// Naming Kira here goes to the local accusation outcome (proof sufficient), reaching the
		// win path rather than re-entering her contact node via the global `target: kira` edge.
		const before = state.history.length;
		step(helix, state, { target: 'kira' });
		expect(state.history).toContain('n13_5_accuser_kira_preuves');
		expect(state.history.slice(before)).not.toContain('n7_kira_contact');
	});
});

describe('gamemaster engine — IRRELEVANT / unmatched input re-prompts without advancing', () => {
	it('helix declares the IRRELEVANT label and a reprompt message', () => {
		const labels = helix.classifierSchemas.helix_intent.properties.label as { enum: string[] };
		expect(labels.enum).toContain('IRRELEVANT');
		expect(typeof helix.reprompt).toBe('string');
	});

	it('an unmatched label keeps the current node, consumes no action, and signals reprompt', () => {
		const state = initState(helix);
		step(helix, state, L('SYSTEME')); // → n2_terminal (awaits input)
		const node = state.currentNode;
		const actions = state.counters.actions;
		const historyLen = state.history.length;

		const res = step(helix, state, L('IRRELEVANT'));

		expect(res.reprompt).toBe(true);
		expect(res.created).toEqual([]);
		expect(res.ending).toBeNull();
		expect(state.currentNode).toBe(node); // did not advance
		expect(state.counters.actions).toBe(actions); // no action consumed
		expect(state.history.length).toBe(historyLen); // no node entered
	});
});
