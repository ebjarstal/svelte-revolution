import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import {
	compile,
	initialState,
	parseYaml,
	step,
	type CompiledScenario,
	type PlayerInput,
	type SessionState
} from '../../../src/lib/narrative';
import { scriptedScenarioSchema } from '../../../src/lib/zschemas/scripted-scenario.schema';

let scn: CompiledScenario;

beforeAll(() => {
	const path = resolve(__dirname, '../../../scenarios/fixtures/3036.yaml');
	const raw = parseYaml(readFileSync(path, 'utf-8'));
	const parsed = scriptedScenarioSchema.parse(raw);
	scn = compile(parsed);
});

function turn(state: SessionState, input: PlayerInput): SessionState {
	const r = step(scn, state, input);
	return r.state;
}

describe('engine — 3036 parcours canoniques', () => {
	test("start state correct (actions_left=null, current_node=N1)", () => {
		const s = initialState(scn);
		expect(s.current_node).toBe('N1');
		expect(s.actions_left).toBeNull();
		expect(s.scores).toEqual({});
	});

	test("FIN_CITOYEN_STABLE : acceptation + tous CONFORME + RIEN", () => {
		let s = initialState(scn);
		s = turn(s, { intent: 'ACCEPT' });               // N1A  conformite=1
		s = turn(s, { classification: 'CONFORME' });     // N2A  conformite=2
		s = turn(s, { classification: 'CONFORME' });     // N3A  conformite=3
		s = turn(s, { intent: 'CHOIX_A' });              // N4A  conformite=4
		s = turn(s, { classification: 'CONFORME' });     // N5A  conformite=5
		s = turn(s, { classification: 'CONFORME' });     // N6A  conformite=6
		s = turn(s, { classification: 'RIEN' });         // N7A  conformite=7
		expect(s.scores.conformite).toBe(7);
		expect(s.scores.eveil ?? 0).toBe(0);
		expect(s.scores.creativite ?? 0).toBe(0);
		expect(s.ended_with).toBe('FIN_CITOYEN_STABLE');
	});

	test("FIN_EVEILLE : hésitation + tous CRITIQUE/REFUS + EVEIL final", () => {
		let s = initialState(scn);
		s = turn(s, { intent: 'HESITER' });              // N1B  creativite=1
		s = turn(s, { classification: 'CRITIQUE' });     // N2C  creativite=3, eveil=1
		s = turn(s, { classification: 'CRITIQUE' });     // N3C  creativite=5, eveil=2
		s = turn(s, { intent: 'REFUS_CHOIX' });          // N4C  creativite=6, eveil=3
		s = turn(s, { classification: 'CRITIQUE' });     // N5C  creativite=8, eveil=5
		s = turn(s, { classification: 'CRITIQUE' });     // N6C  creativite=10, eveil=7
		s = turn(s, { classification: 'EVEIL' });        // N7D  creativite=12, eveil=10
		expect(s.scores.creativite).toBe(12);
		expect(s.scores.eveil).toBe(10);
		expect(s.ended_with).toBe('FIN_EVEILLE');
	});

	test("FIN_INTERROMPUE : 2e refus non-coopératif déclenche end via effet", () => {
		let s = initialState(scn);
		s = turn(s, { intent: 'ACCEPT' });                   // N1A
		s = turn(s, { classification: 'NON_COOPERATIF' });   // N2D : warnings=1, creativite=2
		expect(s.current_node).toBe('N2D');
		expect(s.warnings).toBe(1);
		expect(s.ended_with).toBeNull();
		s = turn(s, { classification: 'NON_COOPERATIF' });   // N_INTERRUPT : warnings=2, end FIN_INTERROMPUE
		expect(s.current_node).toBe('N_INTERRUPT');
		expect(s.ended_with).toBe('FIN_INTERROMPUE');
	});

	test("Score levels (3036) : conformite eleve à 7/7, creativite faible à 0/12", () => {
		// État avec conformite max et creativite zéro
		const s: SessionState = {
			current_node: 'N7A',
			visited_nodes: ['N1', 'N1A', 'N2A', 'N3A', 'N4A', 'N5A', 'N6A', 'N7A'],
			evidences: [],
			scores: { conformite: 7, creativite: 0, eveil: 0 },
			warnings: 0,
			actions_left: null,
			last_intent: null,
			last_classification: 'CONFORME',
			ended_with: null
		};
		const r = step(scn, s, {});
		expect(r.state.ended_with).toBe('FIN_CITOYEN_STABLE');
	});

	test("Précédence : FIN_INTERROMPUE (50) bat les fins de score quand warnings>=2", () => {
		// État avec scores élevés MAIS warnings 2 : interrompue gagne par priorité
		const s: SessionState = {
			current_node: 'N7D',
			visited_nodes: ['N1', 'N1B', 'N2C', 'N3C', 'N4C', 'N5C', 'N6C', 'N7D'],
			evidences: [],
			scores: { creativite: 12, eveil: 10 },
			warnings: 2,
			actions_left: null,
			last_intent: null,
			last_classification: 'EVEIL',
			ended_with: null
		};
		const r = step(scn, s, {});
		expect(r.state.ended_with).toBe('FIN_INTERROMPUE');
	});

	test("FIN_SURVEILLANCE_LEGERE : creativite moyen + eveil faible", () => {
		const s: SessionState = {
			current_node: 'N7B',
			visited_nodes: ['N1', 'N1A', 'N2B', 'N3B', 'N4B', 'N5B', 'N6A', 'N7B'],
			evidences: [],
			// creativite=5 : ratio 5/12 ≈ 0.417 ⇒ moyen ; eveil=0 ⇒ faible
			scores: { conformite: 3, creativite: 5, eveil: 0 },
			warnings: 0,
			actions_left: null,
			last_intent: null,
			last_classification: 'CONFORME',
			ended_with: null
		};
		const r = step(scn, s, {});
		expect(r.state.ended_with).toBe('FIN_SURVEILLANCE_LEGERE');
	});

	test("FIN_REEDUCATION_EXPRESSIVE : creativite eleve + eveil faible/moyen", () => {
		const s: SessionState = {
			current_node: 'N7C',
			visited_nodes: ['N1', 'N1B', 'N2B', 'N3B', 'N4B', 'N5B', 'N6B', 'N7C'],
			evidences: [],
			// creativite=10 : ratio 10/12 ≈ 0.833 ⇒ eleve ; eveil=3 ⇒ faible
			scores: { conformite: 0, creativite: 10, eveil: 3 },
			warnings: 0,
			actions_left: null,
			last_intent: null,
			last_classification: 'CREATIF',
			ended_with: null
		};
		const r = step(scn, s, {});
		expect(r.state.ended_with).toBe('FIN_REEDUCATION_EXPRESSIVE');
	});
});
