// Tests d'intégration du runtime serveur scripted (cf. Phase 5.3).
// On mock le client PocketBase et on rejoue le pipeline complet :
// loadScenarioBundle → readStateFromSession → classifier → engine.step → persist.
// Le moteur lui-même est testé en isolation par engine-helix/engine-3036 ; ici on
// vérifie surtout le **pont PB ↔ runtime** (PB id ↔ external_id, JSON fields).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { compile, initialState, parseYaml } from '../../../src/lib/narrative';
import { scriptedScenarioSchema } from '../../../src/lib/zschemas/scripted-scenario.schema';
import {
	collectAllIntents,
	detectTarget,
	loadScenarioBundle,
	progressScripted,
	readStateFromSession,
	type Classifier
} from '../../../src/lib/scenario/runtime-scripted';
import type { CompiledScenario } from '../../../src/lib/narrative';
import type { MyPocketBase } from '../../../src/types/pocketBase';

const SCENARIO_PB_ID = 'scn1234567890ab';

function loadCompiled(name: string): CompiledScenario {
	const path = resolve(__dirname, '../../../scenarios/fixtures', name);
	return compile(scriptedScenarioSchema.parse(parseYaml(readFileSync(path, 'utf-8'))));
}

// Construit un mock PB pré-rempli avec les rows correspondant à un CompiledScenario.
// Les PB ids sont synthétisés par compteur (préfixe + n° de séquence zéro-paddé) pour
// éviter les collisions de slug (« N1 » et « N10 » produiraient le même hash lexical
// d'un padEnd(11,'0')). Le mock `update()` cible la collection nommée.
function mockPbFromCompiled(opts: {
	compiled: CompiledScenario;
	scenarioPbId?: string;
	session: Record<string, unknown>;
}) {
	const scenarioId = opts.scenarioPbId ?? SCENARIO_PB_ID;
	const updates: Array<{ collection: string; id: string; payload: Record<string, unknown> }> = [];

	const sessionState: Record<string, unknown> = { ...opts.session };

	const mkId = (prefix: string, i: number) => prefix + String(i).padStart(11, '0');

	const nodeRows = opts.compiled.nodes.map((n, i) => ({
		id: mkId('pbn_', i),
		scenario: scenarioId,
		external_id: n.external_id,
		title: n.titre ?? n.external_id,
		text: n.texte ?? '',
		type: n.is_start ? 'startNode' : 'contribution',
		is_start: n.is_start ?? false,
		consumes_action: n.consumes_action ?? false,
		prompt_ia: n.prompt_ia ?? '',
		intents: n.intents ?? null,
		condition: n.condition ?? null,
		effects: n.effects ?? null
	}));

	const endRows = opts.compiled.ends.map((e, i) => ({
		id: mkId('pbe_', i),
		scenario: scenarioId,
		external_id: e.external_id,
		title: e.title,
		text: e.text,
		priority: e.priority,
		condition: e.condition ?? null
	}));

	const charRows = opts.compiled.characters.map((c, i) => ({
		id: mkId('pbc_', i),
		scenario: scenarioId,
		external_id: c.external_id,
		name: c.name,
		role: c.role ?? '',
		bio: c.bio ?? ''
	}));

	const eviRows = opts.compiled.evidences.map((e, i) => ({
		id: mkId('pbv_', i),
		scenario: scenarioId,
		external_id: e.external_id,
		label: e.label,
		description: e.description ?? ''
	}));

	const staxRows = opts.compiled.state_axes.map((a, i) => ({
		id: mkId('pbs_', i),
		scenario: scenarioId,
		external_id: a.external_id,
		label: a.label,
		description: a.description ?? ''
	}));

	const scenarioRow: Record<string, unknown> = {
		id: scenarioId,
		title: opts.compiled.title,
		prologue: opts.compiled.prologue,
		lang: 'fr',
		engine: 'scripted',
		rules: opts.compiled.rules,
		ai: true
	};

	const collections: Record<string, Array<Record<string, unknown>>> = {
		Scenario: [scenarioRow],
		Node: nodeRows,
		End: endRows,
		Characters: charRows,
		Evidences: eviRows,
		StateAxes: staxRows,
		Session: [sessionState]
	};

	const pb = {
		collection: vi.fn((name: string) => ({
			getOne: vi.fn(async (id: string) => {
				const row = collections[name]?.find((r) => r.id === id);
				if (!row) throw Object.assign(new Error(`${name} ${id} not found`), { status: 404 });
				return row;
			}),
			getFullList: vi.fn(async (_opts?: { filter?: string }) => {
				return collections[name] ?? [];
			}),
			update: vi.fn(async (id: string, payload: Record<string, unknown>) => {
				updates.push({ collection: name, id, payload });
				const row = collections[name]?.find((r) => r.id === id);
				if (row) Object.assign(row, payload);
				return row;
			})
		}))
	} as unknown as MyPocketBase;

	const pbIdByExternal = {
		node: new Map(nodeRows.map((r) => [r.external_id, r.id])),
		end: new Map(endRows.map((r) => [r.external_id, r.id]))
	};

	// Filtre les updates ciblant la collection Session — pratique pour les assertions.
	const sessionUpdates = () => updates.filter((u) => u.collection === 'Session');

	return { pb, updates, sessionUpdates, sessionState, nodeRows, endRows, pbIdByExternal };
}

const helix = loadCompiled('helix-corp.yaml');

// ─── loadScenarioBundle ─────────────────────────────────────────────────────

describe('loadScenarioBundle', () => {
	test('reconstruit un CompiledScenario équivalent (nodes/ends/start) à partir de la BD', async () => {
		const { pb } = mockPbFromCompiled({
			compiled: helix,
			session: { id: 'sess', scenario: SCENARIO_PB_ID }
		});
		const bundle = await loadScenarioBundle(pb, SCENARIO_PB_ID);
		expect(bundle.compiled.nodes).toHaveLength(helix.nodes.length);
		expect(bundle.compiled.ends).toHaveLength(helix.ends.length);
		expect(bundle.compiled.startNode?.external_id).toBe(helix.startNode?.external_id);
		expect(bundle.compiled.nodesById.size).toBe(helix.nodes.length);
		expect(bundle.compiled.endsById.size).toBe(helix.ends.length);
	});

	test('expose les bridges PB id ↔ external_id pour Node et End', async () => {
		const { pb, nodeRows, endRows } = mockPbFromCompiled({
			compiled: helix,
			session: { id: 'sess', scenario: SCENARIO_PB_ID }
		});
		const bundle = await loadScenarioBundle(pb, SCENARIO_PB_ID);
		for (const n of nodeRows) {
			expect(bundle.nodePbIdByExternalId.get(n.external_id)).toBe(n.id);
			expect(bundle.nodeExternalIdByPbId.get(n.id)).toBe(n.external_id);
		}
		for (const e of endRows) {
			expect(bundle.endPbIdByExternalId.get(e.external_id)).toBe(e.id);
			expect(bundle.endExternalIdByPbId.get(e.id)).toBe(e.external_id);
		}
	});

	test('rejette un scénario engine="free"', async () => {
		const { pb } = mockPbFromCompiled({
			compiled: helix,
			session: { id: 'sess', scenario: SCENARIO_PB_ID }
		});
		// Mute le scenario à engine='free'
		await pb.collection('Scenario').update(SCENARIO_PB_ID, { engine: 'free' });
		await expect(loadScenarioBundle(pb, SCENARIO_PB_ID)).rejects.toThrow(/engine="free"/);
	});
});

// ─── readStateFromSession ───────────────────────────────────────────────────

describe('readStateFromSession', () => {
	test('traduit current_node PB id → external_id', async () => {
		const bridge = mockBridge(helix);
		const { pb } = mockPbFromCompiled({
			compiled: helix,
			session: {
				id: 'sess',
				scenario: SCENARIO_PB_ID,
				current_node: bridge.node.get('N1'),
				visited_nodes: ['N1'],
				evidences: [],
				scores: {},
				warnings: 0,
				actions_left: helix.rules.initial_actions ?? null,
				completed: false
			}
		});
		const bundle = await loadScenarioBundle(pb, SCENARIO_PB_ID);
		const session = await pb.collection('Session').getOne('sess');
		const state = readStateFromSession(session, bundle);
		expect(state.current_node).toBe('N1');
		expect(state.visited_nodes).toEqual(['N1']);
		expect(state.actions_left).toBe(helix.rules.initial_actions);
		expect(state.ended_with).toBeNull();
	});

	test('ended_with null si completed=false même si Session.end est présent', async () => {
		const bridge = mockBridge(helix);
		const { pb } = mockPbFromCompiled({
			compiled: helix,
			session: {
				id: 'sess',
				scenario: SCENARIO_PB_ID,
				current_node: bridge.node.get('N1'),
				visited_nodes: ['N1'],
				end: bridge.end.get('FIN_REUSSITE'),
				completed: false
			}
		});
		const bundle = await loadScenarioBundle(pb, SCENARIO_PB_ID);
		const session = await pb.collection('Session').getOne('sess');
		const state = readStateFromSession(session, bundle);
		expect(state.ended_with).toBeNull();
	});

	test('ended_with = external_id quand completed=true et Session.end est présent', async () => {
		const bridge = mockBridge(helix);
		const { pb } = mockPbFromCompiled({
			compiled: helix,
			session: {
				id: 'sess',
				scenario: SCENARIO_PB_ID,
				current_node: null,
				visited_nodes: ['N1', 'N2'],
				end: bridge.end.get('FIN_REUSSITE'),
				completed: true
			}
		});
		const bundle = await loadScenarioBundle(pb, SCENARIO_PB_ID);
		const session = await pb.collection('Session').getOne('sess');
		const state = readStateFromSession(session, bundle);
		expect(state.ended_with).toBe('FIN_REUSSITE');
	});

	test('initialState() est une lecture valide d\'une session fraîche', async () => {
		const bridge = mockBridge(helix);
		const { pb } = mockPbFromCompiled({
			compiled: helix,
			session: {
				id: 'sess',
				scenario: SCENARIO_PB_ID,
				current_node: bridge.node.get(helix.startNode!.external_id),
				visited_nodes: [helix.startNode!.external_id],
				evidences: [],
				scores: {},
				warnings: 0,
				actions_left: helix.rules.initial_actions,
				completed: false
			}
		});
		const bundle = await loadScenarioBundle(pb, SCENARIO_PB_ID);
		const session = await pb.collection('Session').getOne('sess');
		const state = readStateFromSession(session, bundle);
		expect(state).toEqual(initialState(helix));
	});
});

// ─── progressScripted ───────────────────────────────────────────────────────

describe('progressScripted', () => {
	function startSession(compiled: CompiledScenario, pbIdByExternal: { node: Map<string, string> }) {
		return {
			id: 'sess',
			scenario: SCENARIO_PB_ID,
			current_node: pbIdByExternal.node.get(compiled.startNode!.external_id),
			visited_nodes: [compiled.startNode!.external_id],
			evidences: [],
			scores: {},
			warnings: 0,
			actions_left: compiled.rules.initial_actions,
			last_intent: '',
			last_classification: '',
			end: null,
			completed: false
		};
	}

	test('appelle le classifier avec prompt_ia du noeud courant + union des intents du scénario', async () => {
		const ctx = mockPbFromCompiled({
			compiled: helix,
			session: startSession(helix, mockBridge(helix))
		});
		const classifier = vi.fn(
			async (
				_text: string,
				_prompt: string,
				_intents: import('../../../src/lib/narrative').IntentDecl[]
			) => ({ intent: 'COMPRENDRE', confidence: 0.8 })
		);
		await progressScripted(ctx.pb, 'sess', 'je veux comprendre', classifier);

		expect(classifier).toHaveBeenCalledTimes(1);
		const [text, prompt, intents] = classifier.mock.calls[0]!;
		expect(text).toBe('je veux comprendre');
		// Le prompt_ia reste celui du noeud courant (N1 = startNode).
		expect(prompt).toBe(helix.startNode!.prompt_ia ?? '');
		// Phase 7+ : la liste d'intents est l'union dédupliquée du scénario complet
		// (cf. design §7.2.4 et fix runtime-scripted), pas seulement N1.intents.
		// On vérifie qu'ACCUSER_FINAL (déclaré uniquement sur N13) est bien proposé
		// dès le premier tour — sinon il serait inatteignable pour le classifier.
		expect(intents).toEqual(collectAllIntents(helix));
		expect(intents.map((i) => i.label)).toContain('ACCUSER_FINAL');
	});

	test('persiste current_node sous forme de PB id (relation), pas d\'external_id', async () => {
		const ctx = mockPbFromCompiled({
			compiled: helix,
			session: startSession(helix, mockBridge(helix))
		});
		const classifier: Classifier = async () => ({ intent: 'COMPRENDRE', confidence: 0.8 });
		await progressScripted(ctx.pb, 'sess', 'je veux comprendre', classifier);

		expect(ctx.sessionUpdates()).toHaveLength(1);
		const u = ctx.sessionUpdates()[0]!;
		expect(u.id).toBe('sess');
		// current_node persisté = PB id, pas external_id
		expect(typeof u.payload.current_node).toBe('string');
		expect((u.payload.current_node as string).startsWith('pbn_')).toBe(true);
		// visited_nodes persisté = external_ids
		expect(u.payload.visited_nodes).toBeInstanceOf(Array);
		for (const v of u.payload.visited_nodes as string[]) {
			expect(v).not.toMatch(/^pbn_/);
		}
	});

	test('persiste last_intent / last_classification depuis le résultat du classifier', async () => {
		const ctx = mockPbFromCompiled({
			compiled: helix,
			session: startSession(helix, mockBridge(helix))
		});
		const classifier: Classifier = async () => ({
			intent: 'SYSTEME',
			classification: undefined,
			confidence: 0.7
		});
		await progressScripted(ctx.pb, 'sess', 'reparer le terminal', classifier);

		const u = ctx.sessionUpdates()[0]!;
		expect(u.payload.last_intent).toBe('SYSTEME');
		expect(u.payload.last_classification).toBe('');
	});

	test('progresse Helix : N1 + intent COMPRENDRE → next_node N2 (état persisté)', async () => {
		const ctx = mockPbFromCompiled({
			compiled: helix,
			session: startSession(helix, mockBridge(helix))
		});
		const classifier: Classifier = async () => ({ intent: 'COMPRENDRE', confidence: 0.9 });
		const result = await progressScripted(ctx.pb, 'sess', 'je veux comprendre', classifier);

		expect(result.next_node?.external_id).toBe('N2');
		expect(result.state.current_node).toBe('N2');
		expect(result.state.visited_nodes).toContain('N2');
		expect(ctx.sessionUpdates()).toHaveLength(1);
	});

	test('atteint une fin (FIN_ECHEC_TEMPS via actions_left → 0) → completed=true + Session.end PB id', async () => {
		// FIN_ECHEC_TEMPS a condition `actions_left: { lte: 0 }` et priority 20. On
		// part avec actions_left=1, l'engine décrémente à 0 sur le step, la fin
		// se déclenche. C'est la fin la plus simple à provoquer mécaniquement
		// (les autres dépendent de noeuds spécifiques visités).
		const compiled = helix;
		const bridge = mockBridge(compiled);
		const sess = {
			id: 'sess',
			scenario: SCENARIO_PB_ID,
			current_node: bridge.node.get('N1'),
			visited_nodes: ['N1'],
			evidences: [],
			scores: {},
			warnings: 0,
			actions_left: 1,
			last_intent: '',
			last_classification: '',
			end: null,
			completed: false
		};
		const ctx = mockPbFromCompiled({ compiled, session: sess });
		const classifier: Classifier = async () => ({ intent: 'COMPRENDRE', confidence: 0.9 });

		const result = await progressScripted(ctx.pb, 'sess', 'je conclus', classifier);
		expect(result.state.actions_left).toBe(0);
		expect(result.end).not.toBeNull();
		expect(result.state.ended_with).toBe(result.end!.external_id);

		const update = ctx.sessionUpdates()[0]!.payload;
		expect(update.completed).toBe(true);
		expect(update.end).toBe(ctx.pbIdByExternal.end.get(result.end!.external_id));
	});

	test('session déjà terminée → no-op (pas d\'update PB)', async () => {
		const compiled = helix;
		const mockBridges = mockBridge(compiled);
		const sess = {
			id: 'sess',
			scenario: SCENARIO_PB_ID,
			current_node: null,
			visited_nodes: ['N1'],
			end: mockBridges.end.get('FIN_REUSSITE'),
			evidences: [],
			scores: {},
			warnings: 0,
			actions_left: 0,
			last_intent: '',
			last_classification: '',
			completed: true
		};
		const ctx = mockPbFromCompiled({ compiled, session: sess });
		const classifier = vi.fn(async () => ({ intent: 'COMPRENDRE', confidence: 0.9 }));

		const result = await progressScripted(ctx.pb, 'sess', 'ignored', classifier);
		expect(result.state.ended_with).toBe('FIN_REUSSITE');
		expect(result.end?.external_id).toBe('FIN_REUSSITE');
		expect(classifier).not.toHaveBeenCalled();
		expect(ctx.sessionUpdates()).toHaveLength(0);
	});

	test('rejette un scénario engine="free"', async () => {
		const ctx = mockPbFromCompiled({
			compiled: helix,
			session: startSession(helix, mockBridge(helix))
		});
		await ctx.pb.collection('Scenario').update(SCENARIO_PB_ID, { engine: 'free' });
		const classifier: Classifier = async () => ({ intent: 'COMPRENDRE', confidence: 0.9 });
		await expect(progressScripted(ctx.pb, 'sess', 'x', classifier)).rejects.toThrow(/engine="free"/);
	});

	test('classifier peut être synchrone (ClassifyResult plain)', async () => {
		const ctx = mockPbFromCompiled({
			compiled: helix,
			session: startSession(helix, mockBridge(helix))
		});
		const classifier: Classifier = () => ({ intent: 'COMPRENDRE', confidence: 0.5 });
		const result = await progressScripted(ctx.pb, 'sess', 'comprendre', classifier);
		expect(result.next_node?.external_id).toBe('N2');
	});

	test('actions_left décrémente sur un noeud qui consomme une action', async () => {
		const ctx = mockPbFromCompiled({
			compiled: helix,
			session: startSession(helix, mockBridge(helix))
		});
		const classifier: Classifier = async () => ({ intent: 'COMPRENDRE', confidence: 0.9 });
		const before = helix.rules.initial_actions ?? 0;
		const result = await progressScripted(ctx.pb, 'sess', 'x', classifier);
		// N2 consume_action n'est pas false ⇒ décrément attendu (cf. engine.ts ligne 73)
		expect(result.state.actions_left).toBe(before - 1);
		expect(ctx.sessionUpdates()[0]!.payload.actions_left).toBe(before - 1);
	});
});

// ─── Helper local : reconstruit le bridge external_id → PB id depuis un compiled ─
// Doit utiliser le MÊME schéma de PB id que `mockPbFromCompiled` ci-dessus (compteur
// par séquence). Sinon, le `Session.current_node` initial ne sera pas résoluble.

describe('detectTarget — déduction du PNJ ciblé depuis le texte joueur', () => {
	const helix = [
		{ external_id: 'nolan', name: 'Nolan Reyes' },
		{ external_id: 'elina', name: 'Dr Elina Voss' },
		{ external_id: 'arman', name: 'Arman Delaunay' },
		{ external_id: 'kira', name: 'Kira Solis' }
	];

	test('match sur external_id', () => {
		expect(detectTarget('je parle à kira', helix)).toBe('kira');
		expect(detectTarget('Demande à nolan ce qu\'il sait', helix)).toBe('nolan');
	});

	test('match sur prénom (premier mot de name)', () => {
		expect(detectTarget('Je confronte Kira avec les preuves', helix)).toBe('kira');
		// Le premier mot d'Elina est "Dr" — exclu (<3 chars dans le helper) ; le matcher
		// retombe sur le external_id "elina" si présent dans le texte.
		expect(detectTarget('Je parle à Elina', helix)).toBe('elina');
	});

	test('insensibilité à la casse et aux diacritiques', () => {
		expect(detectTarget('KIRA, vous êtes responsable', helix)).toBe('kira');
		expect(detectTarget('Élina, qu\'en penses-tu ?', helix)).toBe('elina');
	});

	test('aucun match → undefined', () => {
		expect(detectTarget('je regarde le terminal', helix)).toBeUndefined();
		expect(detectTarget('', helix)).toBeUndefined();
		expect(detectTarget('je parle à quelqu\'un', helix)).toBeUndefined();
	});

	test('ordre du YAML départage les ambiguïtés', () => {
		// Si plusieurs PNJ sont mentionnés, c'est le premier déclaré (nolan) qui gagne.
		expect(detectTarget('Nolan et Kira se regardent', helix)).toBe('nolan');
	});

	test('liste characters vide → undefined sans crasher', () => {
		expect(detectTarget('texte avec kira', [])).toBeUndefined();
	});

	test('ne matche pas un substring (word boundary)', () => {
		// "kirate" contient "kira" en substring mais c'est un autre mot — un Set de
		// tokens distincts ne le pose pas comme match.
		expect(detectTarget('je fais du kirate', helix)).toBeUndefined();
	});
});

function mockBridge(compiled: CompiledScenario) {
	const mkId = (prefix: string, i: number) => prefix + String(i).padStart(11, '0');
	const node = new Map<string, string>();
	compiled.nodes.forEach((n, i) => node.set(n.external_id, mkId('pbn_', i)));
	const end = new Map<string, string>();
	compiled.ends.forEach((e, i) => end.set(e.external_id, mkId('pbe_', i)));
	return { node, end };
}
