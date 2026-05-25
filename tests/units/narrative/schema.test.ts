import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseYaml } from '../../../src/lib/narrative/yaml';
import { scriptedScenarioSchema } from '../../../src/lib/zschemas/scripted-scenario.schema';

function loadFixture(name: string) {
	const path = resolve(__dirname, '../../../scenarios/fixtures', name);
	return parseYaml(readFileSync(path, 'utf-8'));
}

describe('Phase 2 — Zod scripted-scenario.schema', () => {
	test('helix-corp.yaml valide contre le Zod schema', () => {
		const parsed = loadFixture('helix-corp.yaml');
		const result = scriptedScenarioSchema.safeParse(parsed);
		if (!result.success) {
			throw new Error('Zod failures: ' + JSON.stringify(result.error.issues, null, 2));
		}
		expect(result.success).toBe(true);
	});

	test('3036.yaml valide contre le Zod schema', () => {
		const parsed = loadFixture('3036.yaml');
		const result = scriptedScenarioSchema.safeParse(parsed);
		if (!result.success) {
			throw new Error('Zod failures: ' + JSON.stringify(result.error.issues, null, 2));
		}
		expect(result.success).toBe(true);
	});

	test("rejet d'un effet inconnu", () => {
		const bogus = {
			scenario: {
				external_id: 'x',
				title: 't',
				prologue: 'p',
				lang: 'fr-FR',
				engine: 'scripted'
			},
			rules: {},
			characters: [],
			evidences: [],
			state_axes: [],
			nodes: [{ external_id: 'N1', effects: [{ foobar: 'P1' }] }],
			ends: []
		};
		const result = scriptedScenarioSchema.safeParse(bogus);
		expect(result.success).toBe(false);
	});

	test("rejet d'une condition avec clé inconnue (strict)", () => {
		const bogus = {
			scenario: {
				external_id: 'x',
				title: 't',
				prologue: 'p',
				lang: 'fr-FR',
				engine: 'scripted'
			},
			rules: {},
			characters: [],
			evidences: [],
			state_axes: [],
			nodes: [{ external_id: 'N1', condition: { plouf: true } }],
			ends: []
		};
		const result = scriptedScenarioSchema.safeParse(bogus);
		expect(result.success).toBe(false);
	});

	function wrapCondition(cond: unknown) {
		return {
			scenario: {
				external_id: 'x',
				title: 't',
				prologue: 'p',
				lang: 'fr-FR',
				engine: 'scripted'
			},
			rules: {},
			characters: [],
			evidences: [],
			state_axes: [],
			nodes: [{ external_id: 'N1', condition: cond }],
			ends: []
		};
	}

	test('rejet has_count_among sans gte ni lte (juste ids)', () => {
		const result = scriptedScenarioSchema.safeParse(
			wrapCondition({ has_count_among: { ids: ['P1', 'P2'] } })
		);
		expect(result.success).toBe(false);
		if (!result.success) {
			const msg = JSON.stringify(result.error.issues);
			expect(msg).toContain('has_count_among');
		}
	});

	test('rejet score sans gte/lte/eq (juste axis)', () => {
		const result = scriptedScenarioSchema.safeParse(
			wrapCondition({ score: { axis: 'conformite' } })
		);
		expect(result.success).toBe(false);
		if (!result.success) {
			const msg = JSON.stringify(result.error.issues);
			expect(msg).toContain('score');
		}
	});

	test('rejet actions_left objet vide', () => {
		const result = scriptedScenarioSchema.safeParse(
			wrapCondition({ actions_left: {} })
		);
		expect(result.success).toBe(false);
		if (!result.success) {
			const msg = JSON.stringify(result.error.issues);
			expect(msg).toContain('actions_left');
		}
	});

	test('rejet warnings objet vide', () => {
		const result = scriptedScenarioSchema.safeParse(
			wrapCondition({ warnings: {} })
		);
		expect(result.success).toBe(false);
		if (!result.success) {
			const msg = JSON.stringify(result.error.issues);
			expect(msg).toContain('warnings');
		}
	});
});
