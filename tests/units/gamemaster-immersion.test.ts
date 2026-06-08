import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileScenario } from '../../src/lib/scenario/compile';
import { initState, step, type LlmDecision } from '../../src/lib/server/gamemaster/engine';

const read = (name: string) =>
	readFileSync(new URL(`../../scenarios/${name}`, import.meta.url), 'utf-8');

const helix = compileScenario(read('helix.yaml'));
const scenario3036 = compileScenario(read('3036.yaml'));

const L = (label: string): LlmDecision => ({ label });

// Run a scripted playthrough and return the final state.
function play(script: ReturnType<typeof compileScenario>, decisions: LlmDecision[]) {
	const state = initState(script);
	for (const d of decisions) {
		if (state.ended) break;
		step(script, state, d);
	}
	return state;
}

describe('helix — extra dialogue is gated on the evidence flag, not printed unconditionally', () => {
	it('shows Elina’s base access reply when the player lacks P4', () => {
		const state = play(helix, [L('EQUIPAGE'), { target: 'elina' }, L('SYSTEME')]);
		expect(state.currentNode).toBe('n5_3_elina_acces');
		expect(state.history).not.toContain('n5_3_elina_acces_p4');
	});

	it('routes to the P4 variant once the player holds P4_AUTORISATION_MULTIPLE', () => {
		// SYSTEME→n2_terminal, SYSTEME→n2_3_reparation (sets P4), then reach Elina and ask access.
		const state = play(helix, [
			L('SYSTEME'),
			L('SYSTEME'),
			L('EQUIPAGE'),
			{ target: 'elina' },
			L('SYSTEME')
		]);
		expect(state.flags.P4_AUTORISATION_MULTIPLE).toBe(true);
		expect(state.currentNode).toBe('n5_3_elina_acces_p4');
	});

	it('shows Kira’s base access reply when the player lacks P10', () => {
		const state = play(helix, [L('EQUIPAGE'), { target: 'kira' }, L('SYSTEME')]);
		expect(state.currentNode).toBe('n7_2_kira_acces');
		expect(state.history).not.toContain('n7_2_kira_acces_p10');
	});

	it('routes to the P10 variant once the player holds P10_KIRA_A_ACCES_SUPERIEUR', () => {
		// ACCES→n2_4 (sets P5), ACCES→n2_5 (sets P10), then reach Kira and ask access.
		const state = play(helix, [
			L('SYSTEME'),
			L('ACCES'),
			L('ACCES'),
			L('EQUIPAGE'),
			{ target: 'kira' },
			L('SYSTEME')
		]);
		expect(state.flags.P10_KIRA_A_ACCES_SUPERIEUR).toBe(true);
		expect(state.currentNode).toBe('n7_2_kira_acces_p10');
	});
});

describe('scenarios — no internal authoring artifacts leak into player-facing text', () => {
	const titlesOf = (s: ReturnType<typeof compileScenario>) => [
		...s.nodes.map((n) => n.title),
		...s.endings.map((e) => e.title)
	];

	for (const [name, script] of [
		['helix', helix],
		['3036', scenario3036]
	] as const) {
		it(`${name} titles carry no "Noeud N" / "Fin N" numbering prefix`, () => {
			for (const title of titlesOf(script)) {
				if (title == null) continue;
				expect(title, title).not.toMatch(/^Noeud\s/);
				expect(title, title).not.toMatch(/^Fin\s+\d/);
			}
		});

		it(`${name} node text exposes no raw state-flag identifiers`, () => {
			for (const n of script.nodes) {
				// e.g. "P1_SABOTAGE_CONFIRME" — internal flag names must never reach the player.
				expect(n.text, n.id).not.toMatch(/\bP\d+_[A-Z]/);
			}
		});

		it(`${name} node text contains no inline "Si tu possèdes" conditional scaffolding`, () => {
			for (const n of script.nodes) {
				expect(n.text, n.id).not.toMatch(/Si tu poss[èe]des/i);
			}
		});
	}
});
