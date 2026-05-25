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

let helix: CompiledScenario;

beforeAll(() => {
	const path = resolve(__dirname, '../../../scenarios/fixtures/helix-corp.yaml');
	const raw = parseYaml(readFileSync(path, 'utf-8'));
	const parsed = scriptedScenarioSchema.parse(raw);
	helix = compile(parsed);
});

function turn(state: SessionState, input: PlayerInput): SessionState {
	const r = step(helix, state, input);
	return r.state;
}

describe('engine — Helix Corp parcours canoniques', () => {
	test('parcours minimal : N1 → N2 (intent SYSTEME) → N2.1 (intent COMPRENDRE) ⇒ P1 unlocked', () => {
		const s0 = initialState(helix);
		expect(s0.current_node).toBe('N1');
		expect(s0.actions_left).toBe(18);

		const s1 = turn(s0, { intent: 'SYSTEME' });
		expect(s1.current_node).toBe('N2');
		expect(s1.actions_left).toBe(17);
		expect(s1.visited_nodes).toEqual(['N1', 'N2']);

		const s2 = turn(s1, { intent: 'COMPRENDRE' });
		expect(s2.current_node).toBe('N2.1');
		expect(s2.evidences).toContain('P1_SABOTAGE_CONFIRME');
	});

	test('parcours preuves : N1 → N2 → N2.2 (logs ⇒ P2+P3) → N2.4 (acces ⇒ P5) → N2.5 (acces_sup ⇒ P10)', () => {
		let s = initialState(helix);
		s = turn(s, { intent: 'SYSTEME' });          // N2
		s = turn(s, { intent: 'LOGS' });             // N2.2 → P2 + P3
		expect(s.current_node).toBe('N2.2');
		expect(s.evidences).toEqual(expect.arrayContaining(['P2_ACCES_0307', 'P3_LOGS_EFFACES']));
		s = turn(s, { intent: 'ACCES' });            // N2.4 → P5
		expect(s.current_node).toBe('N2.4');
		expect(s.evidences).toContain('P5_ACCES_EQUIPAGE');
		s = turn(s, { intent: 'ACCES_SUPERIEUR' });  // N2.5 → P10
		expect(s.current_node).toBe('N2.5');
		expect(s.evidences).toContain('P10_KIRA_A_ACCES_SUPERIEUR');
	});

	test('parcours équipage : N1 → N3 → N4 (Nolan) → N4.2 (mention 03:07 si P2) ⇒ P7 unlocked', () => {
		let s = initialState(helix);
		s = turn(s, { intent: 'SYSTEME' });
		s = turn(s, { intent: 'LOGS' });   // unlock P2
		// repasse par EQUIPAGE depuis N2 (déjà visité N1+N2)
		s = turn(s, { intent: 'EQUIPAGE' });
		expect(s.current_node).toBe('N3');
		s = turn(s, { target: 'nolan' });
		expect(s.current_node).toBe('N4');
		s = turn(s, { target: 'nolan', intent: 'MENTIONNE_0307' });
		expect(s.current_node).toBe('N4.2');
		expect(s.evidences).toContain('P7_PILOTE_REVEILLE');
	});

	test("FIN_REUSSITE : accusation Kira avec P6 + P10 + P2", () => {
		let s = initialState(helix);
		// Phase preuves
		s = turn(s, { intent: 'SYSTEME' });            // N2
		s = turn(s, { intent: 'LOGS' });               // N2.2 → P2, P3
		s = turn(s, { intent: 'ACCES' });              // N2.4 → P5
		s = turn(s, { intent: 'ACCES_SUPERIEUR' });    // N2.5 → P10
		s = turn(s, { intent: 'EQUIPAGE' });           // N3
		s = turn(s, { target: 'kira' });               // N7
		s = turn(s, { target: 'kira', intent: 'DIRECTIVE_HELIX' });  // N7.4 → P6
		expect(s.evidences).toEqual(expect.arrayContaining([
			'P2_ACCES_0307',
			'P3_LOGS_EFFACES',
			'P5_ACCES_EQUIPAGE',
			'P6_DIRECTIVE_HELIX',
			'P10_KIRA_A_ACCES_SUPERIEUR'
		]));
		// Accusation finale
		const initialActionsBefore = s.actions_left!;
		s = turn(s, { intent: 'ACCUSER_FINAL' });      // N13
		expect(s.current_node).toBe('N13');
		// N13 a consumes_action: false
		expect(s.actions_left).toBe(initialActionsBefore);
		s = turn(s, { target: 'kira' });               // N13.5 (preuves suffisantes)
		expect(s.current_node).toBe('N13.5');
		// Fin évaluée : FIN_REUSSITE (priority 30) gagne
		expect(s.ended_with).toBe('FIN_REUSSITE');
	});

	test("FIN_ECHEC_ACCUSATION : accuse Nolan injustement", () => {
		let s = initialState(helix);
		s = turn(s, { intent: 'EQUIPAGE' });        // N3
		s = turn(s, { intent: 'ACCUSER_FINAL' });   // N13
		s = turn(s, { target: 'nolan' });           // N13.1
		expect(s.current_node).toBe('N13.1');
		// FIN_ECHEC_ACCUSATION (priority 10) doit fire
		expect(s.ended_with).toBe('FIN_ECHEC_ACCUSATION');
	});

	test("FIN_ECHEC_TEMPS : actions_left tombe à 0", () => {
		let s = initialState(helix);
		// On épuise les 18 actions. Pour switcher entre les branches PNJ il faut
		// re-passer par N3 (intent EQUIPAGE consomme aussi une action).
		s = turn(s, { intent: 'SYSTEME' });                                  // N2     17
		s = turn(s, { intent: 'COMPRENDRE' });                               // N2.1   16
		s = turn(s, { intent: 'LOGS' });                                     // N2.2   15
		s = turn(s, { intent: 'REPARER' });                                  // N2.3   14
		s = turn(s, { intent: 'ACCES' });                                    // N2.4   13
		s = turn(s, { intent: 'ACCES_SUPERIEUR' });                          // N2.5   12
		s = turn(s, { intent: 'EQUIPAGE' });                                 // N3     11
		s = turn(s, { intent: 'INTERROGER' });                               // N3.1   10
		s = turn(s, { intent: 'OBSERVER' });                                 // N3.2   9
		s = turn(s, { target: 'nolan' });                                    // N4     8
		s = turn(s, { target: 'nolan', intent: 'COMPRENDRE' });              // N4.1   7
		s = turn(s, { target: 'nolan', intent: 'ACCES_PILOTE' });            // N4.4   6
		s = turn(s, { intent: 'EQUIPAGE' });                                 // N3     5
		s = turn(s, { target: 'elina' });                                    // N5     4
		s = turn(s, { target: 'elina', intent: 'COMPRENDRE' });              // N5.1   3
		s = turn(s, { target: 'elina', intent: 'IRISITE' });                 // N5.2   2
		s = turn(s, { intent: 'EQUIPAGE' });                                 // N3     1
		s = turn(s, { target: 'arman' });                                    // N6     0
		// 18 actions consommées : actions_left ≤ 0 ⇒ FIN_ECHEC_TEMPS
		expect(s.actions_left).toBeLessThanOrEqual(0);
		expect(s.ended_with).toBe('FIN_ECHEC_TEMPS');
	});

	test("Précédence : FIN_REUSSITE (30) bat FIN_ECHEC_ACCUSATION (10) à isodate", () => {
		// Ce cas n'est pas atteignable réellement (un seul N13.x par session)
		// mais on vérifie quand même que priority décroissante gagne en construisant
		// un état artificiel.
		const fakeState: SessionState = {
			current_node: 'N13.5',
			visited_nodes: ['N1', 'N13.5', 'N13.1'],
			evidences: [],
			scores: {},
			warnings: 0,
			actions_left: 5,
			last_intent: null,
			last_classification: null,
			ended_with: null
		};
		const r = step(helix, fakeState, {});
		expect(r.state.ended_with).toBe('FIN_REUSSITE');
	});
});
