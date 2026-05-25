import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { compile, initialState, parseYaml } from '../../../src/lib/narrative';
import { scriptedScenarioSchema } from '../../../src/lib/zschemas/scripted-scenario.schema';
import { createScriptedSession } from '../../../src/lib/scenario/create-scripted-session';
import type { MyPocketBase } from '../../../src/types/pocketBase';

function loadCompiled(name: string) {
	const path = resolve(__dirname, '../../../scenarios/fixtures', name);
	const raw = parseYaml(readFileSync(path, 'utf-8'));
	return compile(scriptedScenarioSchema.parse(raw));
}

interface MockOpts {
	scenarioId?: string;
	engine?: 'free' | 'scripted';
	rules?: Record<string, unknown> | null;
	startNodePbId?: string;
	startNodeExternalId?: string | null;
	existingSlugs?: number[];
	noStartNode?: boolean;
}

function mockPb(opts: MockOpts = {}) {
	const scenarioId = opts.scenarioId ?? 'scn1234567890ab';
	const engine = opts.engine ?? 'scripted';
	// `??` retombe sur le défaut pour null aussi — on veut pouvoir tester
	// rules=null explicitement, donc on distingue "absent" de "explicit null".
	const rules = 'rules' in opts ? opts.rules : { initial_actions: 6 };
	const startNodePbId = opts.startNodePbId ?? 'startnode1234ab';
	const startNodeExternalId = opts.startNodeExternalId === undefined ? 'N1' : opts.startNodeExternalId;
	const existingSlugs = opts.existingSlugs ?? [];
	const noStartNode = opts.noStartNode ?? false;

	const calls: Array<{ collection: string; op: string; arg?: unknown; payload?: unknown }> = [];

	const services: Record<string, unknown> = {
		Scenario: {
			getOne: vi.fn(async (id: string) => {
				calls.push({ collection: 'Scenario', op: 'getOne', arg: id });
				return { id, engine, rules };
			})
		},
		Node: {
			getFirstListItem: vi.fn(async (filter: string, options?: unknown) => {
				calls.push({ collection: 'Node', op: 'getFirstListItem', arg: { filter, options } });
				if (noStartNode) {
					const err = Object.assign(new Error('no rows'), { status: 404 });
					throw err;
				}
				return { id: startNodePbId, external_id: startNodeExternalId };
			})
		},
		Session: {
			getFullList: vi.fn(async (options?: unknown) => {
				calls.push({ collection: 'Session', op: 'getFullList', arg: options });
				return existingSlugs.map((slug, i) => ({ id: `sess${i}`, slug }));
			}),
			create: vi.fn(async (payload: Record<string, unknown>) => {
				calls.push({ collection: 'Session', op: 'create', payload });
				return { id: 'newsess12345678', ...payload };
			})
		}
	};

	const pb = {
		collection: vi.fn((name: string) => services[name]!)
	} as unknown as MyPocketBase;

	return { pb, calls, services };
}

describe('createScriptedSession', () => {
	test('rejette un scénario non-scripted', async () => {
		const { pb } = mockPb({ engine: 'free' });
		await expect(
			createScriptedSession(pb, {
				name: 'partie test',
				scenario: 'scn1234567890ab',
				author: 'usr1234567890abc',
				image: '',
				useAudio: false
			})
		).rejects.toThrow(/engine="free"/);
	});

	test('appelle Scenario.getOne puis Node.getFirstListItem avec un filtre is_start=true', async () => {
		const { pb, services } = mockPb();
		await createScriptedSession(pb, {
			name: 'partie test',
			scenario: 'scn1234567890ab',
			author: 'usr1234567890abc',
			image: '',
			useAudio: false
		});
		const nodeSvc = services.Node as { getFirstListItem: { mock: { calls: unknown[][] } } };
		const [filter] = nodeSvc.getFirstListItem.mock.calls[0]!;
		expect(filter).toContain('scenario="scn1234567890ab"');
		expect(filter).toContain('is_start=true');
	});

	test('payload Session contient l\'état runtime initial complet', async () => {
		const { pb, services } = mockPb({
			startNodePbId: 'pbid_startnode1',
			startNodeExternalId: 'N1',
			rules: { initial_actions: 6 }
		});
		await createScriptedSession(pb, {
			name: 'partie test',
			scenario: 'scn1234567890ab',
			author: 'usr1234567890abc',
			image: '',
			useAudio: false
		});
		const sessSvc = services.Session as { create: { mock: { calls: unknown[][] } } };
		const payload = sessSvc.create.mock.calls[0]![0] as Record<string, unknown>;
		expect(payload.current_node).toBe('pbid_startnode1'); // relation = PB id
		expect(payload.visited_nodes).toEqual(['N1']); // json = external_id
		expect(payload.evidences).toEqual([]);
		expect(payload.scores).toEqual({});
		expect(payload.warnings).toBe(0);
		expect(payload.actions_left).toBe(6);
		expect(payload.last_intent).toBe('');
		expect(payload.last_classification).toBe('');
		expect(payload.completed).toBe(false);
		expect(payload.scenario).toBe('scn1234567890ab');
		expect(payload.author).toBe('usr1234567890abc');
		expect(payload.name).toBe('partie test');
	});

	test('actions_left = null si scenario.rules.initial_actions est absent', async () => {
		const { pb, services } = mockPb({ rules: { score_caps: { conformite: 7 } } });
		await createScriptedSession(pb, {
			name: 'p',
			scenario: 'scn1234567890ab',
			author: 'usr1234567890abc',
			image: '',
			useAudio: false
		});
		const sessSvc = services.Session as { create: { mock: { calls: unknown[][] } } };
		const payload = sessSvc.create.mock.calls[0]![0] as Record<string, unknown>;
		expect(payload.actions_left).toBeNull();
	});

	test('actions_left = null si scenario.rules est null', async () => {
		const { pb, services } = mockPb({ rules: null });
		await createScriptedSession(pb, {
			name: 'p',
			scenario: 'scn1234567890ab',
			author: 'usr1234567890abc',
			image: '',
			useAudio: false
		});
		const sessSvc = services.Session as { create: { mock: { calls: unknown[][] } } };
		const payload = sessSvc.create.mock.calls[0]![0] as Record<string, unknown>;
		expect(payload.actions_left).toBeNull();
	});

	test('slug = max(existing) + 1 ; 1 si aucune session', async () => {
		const { pb, services } = mockPb({ existingSlugs: [1, 3, 7] });
		await createScriptedSession(pb, {
			name: 'p',
			scenario: 'scn1234567890ab',
			author: 'usr1234567890abc',
			image: '',
			useAudio: false
		});
		const sessSvc = services.Session as { create: { mock: { calls: unknown[][] } } };
		const payload = sessSvc.create.mock.calls[0]![0] as Record<string, unknown>;
		expect(payload.slug).toBe(8);

		const { pb: pb2, services: svc2 } = mockPb({ existingSlugs: [] });
		await createScriptedSession(pb2, {
			name: 'p',
			scenario: 'scn1234567890ab',
			author: 'usr1234567890abc',
			image: '',
			useAudio: false
		});
		const sessSvc2 = svc2.Session as { create: { mock: { calls: unknown[][] } } };
		const payload2 = sessSvc2.create.mock.calls[0]![0] as Record<string, unknown>;
		expect(payload2.slug).toBe(1);
	});

	test('aucun appel à /api/ai/newAiSession (path free-engine, hors scope scripted)', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
		const { pb } = mockPb();
		await createScriptedSession(pb, {
			name: 'p',
			scenario: 'scn1234567890ab',
			author: 'usr1234567890abc',
			image: '',
			useAudio: false
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	test('alignement avec initialState() de $lib/narrative — helix-corp.yaml', async () => {
		const compiled = loadCompiled('helix-corp.yaml');
		const expected = initialState(compiled);
		const { pb, services } = mockPb({
			startNodePbId: 'pbid_helix_n1__',
			startNodeExternalId: compiled.startNode!.external_id,
			rules: { initial_actions: compiled.rules.initial_actions }
		});
		await createScriptedSession(pb, {
			name: 'partie helix',
			scenario: 'scn1234567890ab',
			author: 'usr1234567890abc',
			image: '',
			useAudio: false
		});
		const sessSvc = services.Session as { create: { mock: { calls: unknown[][] } } };
		const payload = sessSvc.create.mock.calls[0]![0] as Record<string, unknown>;
		// current_node diverge : runtime = external_id, PB = relation/PB id
		expect(payload.visited_nodes).toEqual(expected.visited_nodes);
		expect(payload.evidences).toEqual(expected.evidences);
		expect(payload.scores).toEqual(expected.scores);
		expect(payload.warnings).toBe(expected.warnings);
		expect(payload.actions_left).toBe(expected.actions_left);
	});

	test('alignement avec initialState() — 3036.yaml (avec score_caps)', async () => {
		const compiled = loadCompiled('3036.yaml');
		const expected = initialState(compiled);
		const { pb, services } = mockPb({
			startNodePbId: 'pbid_3036_n0___',
			startNodeExternalId: compiled.startNode!.external_id,
			rules: { initial_actions: compiled.rules.initial_actions }
		});
		await createScriptedSession(pb, {
			name: 'partie 3036',
			scenario: 'scn1234567890ab',
			author: 'usr1234567890abc',
			image: '',
			useAudio: false
		});
		const sessSvc = services.Session as { create: { mock: { calls: unknown[][] } } };
		const payload = sessSvc.create.mock.calls[0]![0] as Record<string, unknown>;
		expect(payload.visited_nodes).toEqual(expected.visited_nodes);
		expect(payload.actions_left).toBe(expected.actions_left);
	});

	test('propage l\'erreur 404 si aucun noeud is_start=true n\'existe', async () => {
		const { pb } = mockPb({ noStartNode: true });
		await expect(
			createScriptedSession(pb, {
				name: 'p',
				scenario: 'scn1234567890ab',
				author: 'usr1234567890abc',
				image: '',
				useAudio: false
			})
		).rejects.toThrow();
	});
});
