import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { compile, parseYaml } from '../../../src/lib/narrative';
import { scriptedScenarioSchema } from '../../../src/lib/zschemas/scripted-scenario.schema';
import {
	BatchPersistError,
	persistCompiledScenario
} from '../../../src/lib/scenario/persist-scripted';
import type { MyPocketBase } from '../../../src/types/pocketBase';

function loadCompiled(name: string) {
	const path = resolve(__dirname, '../../../scenarios/fixtures', name);
	const raw = parseYaml(readFileSync(path, 'utf-8'));
	const parsed = scriptedScenarioSchema.parse(raw);
	return compile(parsed);
}

interface RecordedCall {
	collection: string;
	op: 'create' | 'update';
	payload: Record<string, unknown>;
	targetId?: string;
}

function mockPb(opts: { failOnSend?: boolean } = {}) {
	const calls: RecordedCall[] = [];
	const sub = (collection: string) => ({
		create: (payload: Record<string, unknown>) => {
			calls.push({ collection, op: 'create', payload });
		},
		update: (id: string, payload: Record<string, unknown>) => {
			calls.push({ collection, op: 'update', payload, targetId: id });
		}
	});
	const batch = {
		collection: vi.fn((c: string) => sub(c)),
		send: vi.fn(async () => {
			if (opts.failOnSend) throw Object.assign(new Error('boom'), { status: 400 });
			return calls.map(() => ({ status: 200, body: {} }));
		})
	};
	const pb = {
		createBatch: vi.fn(() => batch)
	} as unknown as MyPocketBase;
	return { pb, batch, calls };
}

describe('persistCompiledScenario', () => {
	test('ordre des appels : Scenario → Characters → Evidences → StateAxes → Node → End', async () => {
		const compiled = loadCompiled('helix-corp.yaml');
		const { pb, calls } = mockPb();

		await persistCompiledScenario(pb, compiled, 'aaaaaaaaaaaaaaa');

		const order = calls.map((c) => c.collection);
		expect(order[0]).toBe('Scenario');

		const firstCharsIdx = order.findIndex((c) => c === 'Characters');
		const firstEvidIdx = order.findIndex((c) => c === 'Evidences');
		const firstStaxIdx = order.findIndex((c) => c === 'StateAxes');
		const firstNodeIdx = order.findIndex((c) => c === 'Node');
		const firstEndIdx = order.findIndex((c) => c === 'End');

		expect(firstCharsIdx).toBeGreaterThan(0);
		expect(firstEvidIdx).toBeGreaterThan(firstCharsIdx);
		// StateAxes peut être vide (helix-corp.yaml) — on n'asserte la position que si présent.
		if (firstStaxIdx !== -1) {
			expect(firstStaxIdx).toBeGreaterThan(firstEvidIdx);
			expect(firstNodeIdx).toBeGreaterThan(firstStaxIdx);
		} else {
			expect(firstNodeIdx).toBeGreaterThan(firstEvidIdx);
		}
		expect(firstEndIdx).toBeGreaterThan(firstNodeIdx);

		expect(calls.filter((c) => c.collection === 'Characters')).toHaveLength(compiled.characters.length);
		expect(calls.filter((c) => c.collection === 'Evidences')).toHaveLength(compiled.evidences.length);
		expect(calls.filter((c) => c.collection === 'StateAxes')).toHaveLength(compiled.state_axes.length);
		expect(calls.filter((c) => c.collection === 'Node')).toHaveLength(compiled.nodes.length);
		expect(calls.filter((c) => c.collection === 'End')).toHaveLength(compiled.ends.length);
	});

	test('3036.yaml : StateAxes est créé entre Evidences et Node', async () => {
		const compiled = loadCompiled('3036.yaml');
		const { pb, calls } = mockPb();

		await persistCompiledScenario(pb, compiled, 'uploaderxyz1234');

		const order = calls.map((c) => c.collection);
		const firstEvidIdx = order.findIndex((c) => c === 'Evidences');
		const firstStaxIdx = order.findIndex((c) => c === 'StateAxes');
		const firstNodeIdx = order.findIndex((c) => c === 'Node');

		expect(compiled.state_axes.length).toBeGreaterThan(0);
		expect(firstStaxIdx).toBeGreaterThan(firstEvidIdx);
		expect(firstNodeIdx).toBeGreaterThan(firstStaxIdx);
		expect(calls.filter((c) => c.collection === 'StateAxes')).toHaveLength(compiled.state_axes.length);
	});

	test('payload Scenario contient firstNodeTitle/Text/Author depuis le startNode + uploaderId', async () => {
		const compiled = loadCompiled('helix-corp.yaml');
		const { pb, calls } = mockPb();

		await persistCompiledScenario(pb, compiled, 'uploaderxyz1234');

		const scn = calls.find((c) => c.collection === 'Scenario')!;
		expect(scn.payload.firstNodeTitle).toBe(compiled.startNode?.titre);
		expect(scn.payload.firstNodeText).toBe(compiled.startNode?.texte);
		expect(scn.payload.firstNodeAuthor).toBe('uploaderxyz1234');
		expect(scn.payload.engine).toBe('scripted');
		expect(scn.payload.lang).toBe('fr');
		expect(scn.payload.ai).toBe(true);
		expect(scn.payload.id).toMatch(/^[a-z0-9]{15}$/);
	});

	test('relations N→N câblées via Scenario.update après création des enfants', async () => {
		const compiled = loadCompiled('helix-corp.yaml');
		const { pb, calls } = mockPb();

		await persistCompiledScenario(pb, compiled, 'uploaderxyz1234');

		// Scenario.create initial : pas de relations N→N (sinon PB rejette).
		const scnCreate = calls.find((c) => c.collection === 'Scenario' && c.op === 'create')!;
		expect(scnCreate.payload.characters).toBeUndefined();
		expect(scnCreate.payload.evidences).toBeUndefined();
		expect(scnCreate.payload.state_axes).toBeUndefined();

		// Scenario.update plus loin dans le batch : contient les FK.
		const scnUpdate = calls.find((c) => c.collection === 'Scenario' && c.op === 'update')!;
		expect(scnUpdate).toBeDefined();

		const charsCalls = calls.filter((c) => c.collection === 'Characters');
		expect(scnUpdate.payload.characters).toEqual(charsCalls.map((c) => c.payload.id));
		expect((scnUpdate.payload.characters as string[])).toHaveLength(compiled.characters.length);
		expect((scnUpdate.payload.evidences as string[])).toHaveLength(compiled.evidences.length);
		expect((scnUpdate.payload.state_axes as string[])).toHaveLength(compiled.state_axes.length);

		// L'update doit venir APRÈS les Characters/Evidences/StateAxes.
		const updateIdx = calls.indexOf(scnUpdate);
		const lastChildIdx = Math.max(
			...calls
				.map((c, i) => (['Characters', 'Evidences', 'StateAxes'].includes(c.collection) ? i : -1))
				.filter((i) => i >= 0)
		);
		expect(updateIdx).toBeGreaterThan(lastChildIdx);
	});

	test('Scenario.update est skippé si aucune relation N→N à câbler', async () => {
		const compiled = loadCompiled('helix-corp.yaml');
		// muter la fixture en vidant tous les enfants
		compiled.characters = [];
		compiled.evidences = [];
		compiled.state_axes = [];

		const { pb, calls } = mockPb();
		await persistCompiledScenario(pb, compiled, 'uploaderxyz1234');

		const updates = calls.filter((c) => c.collection === 'Scenario' && c.op === 'update');
		expect(updates).toHaveLength(0);
	});

	test('FK Node.scenario / Characters.scenario etc. pointent vers le scenarioId pré-généré', async () => {
		const compiled = loadCompiled('helix-corp.yaml');
		const { pb, calls } = mockPb();

		const { scenarioId } = await persistCompiledScenario(pb, compiled, 'uploaderxyz1234');

		expect(scenarioId).toMatch(/^[a-z0-9]{15}$/);
		for (const c of calls.filter((c) => c.collection !== 'Scenario')) {
			expect(c.payload.scenario).toBe(scenarioId);
		}
	});

	test('Node.type = startNode pour is_start, contribution sinon', async () => {
		const compiled = loadCompiled('helix-corp.yaml');
		const { pb, calls } = mockPb();

		await persistCompiledScenario(pb, compiled, 'uploaderxyz1234');

		const nodeCalls = calls.filter((c) => c.collection === 'Node');
		const startCalls = nodeCalls.filter((c) => c.payload.is_start === true);
		expect(startCalls).toHaveLength(1);
		expect(startCalls[0]!.payload.type).toBe('startNode');

		const others = nodeCalls.filter((c) => c.payload.is_start !== true);
		for (const n of others) expect(n.payload.type).toBe('contribution');
	});

	test('Node sans condition reçoit condition: null (pas undefined)', async () => {
		const compiled = loadCompiled('helix-corp.yaml');
		const { pb, calls } = mockPb();

		await persistCompiledScenario(pb, compiled, 'uploaderxyz1234');

		const nodesWithoutCondition = compiled.nodes.filter((n) => n.condition === undefined);
		if (nodesWithoutCondition.length === 0) throw new Error('fixture sans noeud condition-less : test impossible');

		const target = nodesWithoutCondition[0]!;
		const call = calls.find((c) => c.collection === 'Node' && c.payload.external_id === target.external_id);
		expect(call).toBeDefined();
		expect(call!.payload.condition).toBeNull();
	});

	test('End payload contient title, text, priority, condition (null si absent)', async () => {
		const compiled = loadCompiled('3036.yaml');
		const { pb, calls } = mockPb();

		await persistCompiledScenario(pb, compiled, 'uploaderxyz1234');

		const endCalls = calls.filter((c) => c.collection === 'End');
		expect(endCalls).toHaveLength(compiled.ends.length);
		for (const e of endCalls) {
			expect(typeof e.payload.title).toBe('string');
			expect(typeof e.payload.text).toBe('string');
			expect(typeof e.payload.priority).toBe('number');
			expect(e.payload.condition === null || typeof e.payload.condition === 'object').toBe(true);
		}
	});

	test('échec batch.send() est wrappé en BatchPersistError', async () => {
		const compiled = loadCompiled('helix-corp.yaml');
		const { pb } = mockPb({ failOnSend: true });

		await expect(persistCompiledScenario(pb, compiled, 'uploaderxyz1234')).rejects.toBeInstanceOf(
			BatchPersistError
		);
	});

	test('mapLang : fr-FR → fr, en-US → en, ja-JP → jp, valeur inconnue → fr', async () => {
		const compiled = loadCompiled('helix-corp.yaml');
		const { pb, calls } = mockPb();
		compiled.lang = 'en-US';
		await persistCompiledScenario(pb, compiled, 'uploaderxyz1234');
		const scn = calls.find((c) => c.collection === 'Scenario')!;
		expect(scn.payload.lang).toBe('en');

		const c2 = mockPb();
		compiled.lang = 'ja-JP';
		await persistCompiledScenario(c2.pb, compiled, 'uploaderxyz1234');
		expect(c2.calls.find((c) => c.collection === 'Scenario')!.payload.lang).toBe('jp');

		const c3 = mockPb();
		compiled.lang = 'xx-YY';
		await persistCompiledScenario(c3.pb, compiled, 'uploaderxyz1234');
		expect(c3.calls.find((c) => c.collection === 'Scenario')!.payload.lang).toBe('fr');
	});
});
