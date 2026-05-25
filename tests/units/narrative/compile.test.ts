// Tests sur `compile()` — détection des doublons d'external_id par collection.
// Le moteur free n'utilise pas ces collections ; le scripted exige l'unicité car les
// références DSL (`target: nolan`, `unlock: P_X`, etc.) résolvent par external_id.

import { describe, expect, test } from 'vitest';
import { compile } from '../../../src/lib/narrative';
import type { ScriptedScenarioFixture } from '../../../src/lib/narrative';

function baseFixture(): ScriptedScenarioFixture {
	return {
		scenario: {
			external_id: 'test',
			title: 'Test',
			prologue: '',
			lang: 'fr-FR',
			engine: 'scripted'
		},
		rules: {},
		characters: [],
		evidences: [],
		state_axes: [],
		nodes: [{ external_id: 'N1', is_start: true }],
		ends: []
	};
}

describe('compile — détection des doublons d\'external_id', () => {
	test('Characters : deux PNJ avec le même external_id', () => {
		const fx = baseFixture();
		fx.characters = [
			{ external_id: 'nolan', name: 'Nolan' },
			{ external_id: 'nolan', name: 'Autre Nolan' }
		];
		expect(() => compile(fx)).toThrow(/doublon d'external_id de character.*nolan/);
	});

	test('Evidences : deux preuves avec le même external_id', () => {
		const fx = baseFixture();
		fx.evidences = [
			{ external_id: 'P1', label: 'preuve 1' },
			{ external_id: 'P1', label: 'preuve dupliquée' }
		];
		expect(() => compile(fx)).toThrow(/doublon d'external_id de evidence.*P1/);
	});

	test('StateAxes : deux axes avec le même external_id', () => {
		const fx = baseFixture();
		fx.state_axes = [
			{ external_id: 'conformite', label: 'Conformité' },
			{ external_id: 'conformite', label: 'Conformité bis' }
		];
		expect(() => compile(fx)).toThrow(/doublon d'external_id de state_axis.*conformite/);
	});

	test('Nodes : doublon continue à être détecté (régression)', () => {
		const fx = baseFixture();
		fx.nodes = [
			{ external_id: 'N1', is_start: true },
			{ external_id: 'N1' }
		];
		expect(() => compile(fx)).toThrow(/doublon d'external_id de noeud.*N1/);
	});

	test('Ends : doublon continue à être détecté (régression)', () => {
		const fx = baseFixture();
		fx.ends = [
			{ external_id: 'FIN', title: 'A', priority: 0, text: 'a' },
			{ external_id: 'FIN', title: 'B', priority: 0, text: 'b' }
		];
		expect(() => compile(fx)).toThrow(/doublon d'external_id de fin.*FIN/);
	});

	test('happy path : aucun doublon → compile() retourne un scenario indexé', () => {
		const fx = baseFixture();
		fx.characters = [
			{ external_id: 'a', name: 'A' },
			{ external_id: 'b', name: 'B' }
		];
		const compiled = compile(fx);
		expect(compiled.characters).toHaveLength(2);
	});
});
