// Test d'intégration round-trip : parseYaml → safeParse → compile →
// validateReferences → persistCompiledScenario, sur les deux fixtures
// canoniques. Vérifie que le pipeline end-to-end ne throw nulle part et que
// les comptes finaux correspondent au contenu du YAML.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { compile, parseYaml } from '../../../src/lib/narrative';
import { scriptedScenarioSchema } from '../../../src/lib/zschemas/scripted-scenario.schema';
import { validateReferences } from '../../../src/lib/scenario/validate-references';
import { persistCompiledScenario } from '../../../src/lib/scenario/persist-scripted';
import type { MyPocketBase } from '../../../src/types/pocketBase';

interface RecordedCall {
	collection: string;
	op: 'create' | 'update';
	payload: Record<string, unknown>;
}

function mockPb() {
	const calls: RecordedCall[] = [];
	const sub = (collection: string) => ({
		create: (payload: Record<string, unknown>) => {
			calls.push({ collection, op: 'create', payload });
		},
		update: (_id: string, payload: Record<string, unknown>) => {
			calls.push({ collection, op: 'update', payload });
		}
	});
	const batch = {
		collection: vi.fn((c: string) => sub(c)),
		send: vi.fn(async () => calls.map(() => ({ status: 200, body: {} })))
	};
	const pb = {
		createBatch: vi.fn(() => batch)
	} as unknown as MyPocketBase;
	return { pb, calls };
}

function roundTrip(name: string) {
	const path = resolve(__dirname, '../../../scenarios/fixtures', name);
	const raw = parseYaml(readFileSync(path, 'utf-8'));
	const parsed = scriptedScenarioSchema.parse(raw);
	const compiled = compile(parsed);
	const refIssues = validateReferences(compiled);
	return { compiled, refIssues };
}

describe('round-trip YAML → compile → validate → persist', () => {
	test.each([
		['helix-corp.yaml', 'helix_corp'],
		['3036.yaml', 'scn_3036']
	])('%s : pipeline complet sans erreur', async (file, externalId) => {
		const { compiled, refIssues } = roundTrip(file);
		expect(compiled.external_id).toBe(externalId);
		expect(refIssues).toEqual([]);

		const { pb, calls } = mockPb();
		const { scenarioId } = await persistCompiledScenario(pb, compiled, 'aaaaaaaaaaaaaaa');

		expect(scenarioId).toMatch(/^[a-z0-9]{15}$/);

		const creates = calls.filter((c) => c.op === 'create');
		const countsByColl = creates.reduce<Record<string, number>>((acc, c) => {
			acc[c.collection] = (acc[c.collection] ?? 0) + 1;
			return acc;
		}, {});

		expect(countsByColl.Scenario).toBe(1);
		expect(countsByColl.Characters ?? 0).toBe(compiled.characters.length);
		expect(countsByColl.Evidences ?? 0).toBe(compiled.evidences.length);
		expect(countsByColl.StateAxes ?? 0).toBe(compiled.state_axes.length);
		expect(countsByColl.Node).toBe(compiled.nodes.length);
		expect(countsByColl.End).toBe(compiled.ends.length);

		// Les deux fixtures ont au moins characters+evidences non-vides → un Scenario.update doit avoir câblé les N→N.
		const updates = calls.filter((c) => c.collection === 'Scenario' && c.op === 'update');
		expect(updates).toHaveLength(1);
	});

	test('helix-corp : récap des comptes attendus (4 chars, 10 preuves, 0 axes, 3 fins)', () => {
		const { compiled, refIssues } = roundTrip('helix-corp.yaml');
		expect(refIssues).toEqual([]);
		expect(compiled.characters.length).toBe(4);
		expect(compiled.evidences.length).toBe(10);
		expect(compiled.state_axes.length).toBe(0);
		expect(compiled.ends.length).toBe(3);
	});

	test('3036 : récap des comptes attendus (3 axes, 5 fins)', () => {
		const { compiled, refIssues } = roundTrip('3036.yaml');
		expect(refIssues).toEqual([]);
		expect(compiled.state_axes.length).toBe(3);
		expect(compiled.ends.length).toBe(5);
	});
});
