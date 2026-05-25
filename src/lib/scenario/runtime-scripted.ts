// Runtime serveur du moteur scripted (cf. docs/narrative-engine-design.md §7.2 / §12 Phase 5.3).
// Glue entre le moteur pur `$lib/narrative` et la base PocketBase. Reçoit un id de Session,
// reconstruit le CompiledScenario à partir des rows PB (Scenario + Node + End + Characters +
// Evidences + StateAxes), reconstitue l'état runtime, appelle un classifier injecté, fait
// avancer le moteur d'un tour, persiste le nouvel état.
//
// Pont d'identifiants (cf. §3.2) :
//   - `Session.current_node` PB est une **relation** (PB id) → côté runtime, c'est un
//     `external_id` string. On utilise une map nodePbIdByExternalId pour traduire dans
//     les deux sens.
//   - `Session.end` (relation, PB id) ↔ `state.ended_with` (external_id) : idem.
//   - `Session.visited_nodes` / `evidences` (JSON) stockent directement des external_ids.
//
// Le classifier est injecté pour qu'on puisse swap le stub TS (Phase 5.2) vers le Go
// word2vec (Phase 6) sans toucher ce module.

// Imports VALEUR via chemin relatif : sous Vitest, l'alias `$lib` n'est pas résolu pour
// les imports valeur (cf. persist-scripted.ts qui n'utilise `$lib/narrative` qu'en
// `import type`). Les imports type passent par `$lib` sans souci, ils sont strippés.
import { compile, step } from '../narrative';
import type {
	ClassifyResult,
	CompiledScenario,
	Condition,
	Effect,
	EndFixture,
	IntentDecl,
	NodeFixture,
	ScenarioRules,
	SessionState,
	StepResult
} from '$lib/narrative';
import type { End, GraphNode, Session } from '$types/pocketBase/TableTypes';
import type { MyPocketBase } from '$types/pocketBase';

export type Classifier = (
	text: string,
	prompt_ia: string,
	intents: IntentDecl[]
) => ClassifyResult | Promise<ClassifyResult>;

export async function progressScripted(
	pb: MyPocketBase,
	sessionId: string,
	playerText: string,
	classifier: Classifier
): Promise<StepResult> {
	const session = await pb.collection('Session').getOne(sessionId);
	const bundle = await loadScenarioBundle(pb, session.scenario);
	const state = readStateFromSession(session, bundle);

	// Session déjà terminée — pas d'avancée, on rend la valeur figée que step() retournerait.
	if (state.ended_with !== null) {
		return step(bundle.compiled, state, {});
	}

	const currentNode =
		state.current_node !== null ? bundle.compiled.nodesById.get(state.current_node) ?? null : null;
	const intents = (currentNode?.intents ?? []) as IntentDecl[];
	const promptIa = currentNode?.prompt_ia ?? '';

	const classification = await classifier(playerText, promptIa, intents);

	const result = step(bundle.compiled, state, {
		text: playerText,
		intent: classification.intent || undefined,
		classification: classification.classification
	});

	await persistState(pb, sessionId, result.state, bundle);

	return result;
}

// ─── Bundle scénario : compile + bridges PB id ↔ external_id ─────────────────

interface ScenarioBundle {
	compiled: CompiledScenario;
	nodePbIdByExternalId: Map<string, string>;
	nodeExternalIdByPbId: Map<string, string>;
	endPbIdByExternalId: Map<string, string>;
	endExternalIdByPbId: Map<string, string>;
}

export async function loadScenarioBundle(
	pb: MyPocketBase,
	scenarioId: string
): Promise<ScenarioBundle> {
	const scenario = await pb.collection('Scenario').getOne(scenarioId);
	if (scenario.engine !== 'scripted') {
		throw new Error(
			`progressScripted appelé sur un scénario engine="${scenario.engine ?? 'free'}"`
		);
	}

	const filter = `scenario="${scenarioId}"`;
	const [nodes, ends, characters, evidences, stateAxes] = await Promise.all([
		pb.collection('Node').getFullList({ filter }),
		pb.collection('End').getFullList({ filter }),
		pb.collection('Characters').getFullList({ filter }),
		pb.collection('Evidences').getFullList({ filter }),
		pb.collection('StateAxes').getFullList({ filter })
	]);

	const nodeFixtures: NodeFixture[] = nodes.map(buildNodeFixture);
	const endFixtures: EndFixture[] = ends.map(buildEndFixture);

	const nodesById = new Map<string, NodeFixture>();
	for (const n of nodeFixtures) nodesById.set(n.external_id, n);
	const endsById = new Map<string, EndFixture>();
	for (const e of endFixtures) endsById.set(e.external_id, e);

	const startNode = nodeFixtures.find((n) => n.is_start === true) ?? null;

	const compiled: CompiledScenario = {
		external_id: scenario.id,
		title: scenario.title,
		prologue: scenario.prologue,
		lang: scenario.lang,
		rules: (scenario.rules ?? {}) as ScenarioRules,
		characters: characters.map((c) => ({
			external_id: c.external_id,
			name: c.name,
			role: c.role || undefined,
			bio: c.bio || undefined
		})),
		evidences: evidences.map((e) => ({
			external_id: e.external_id,
			label: e.label,
			description: e.description || undefined
		})),
		state_axes: stateAxes.map((a) => ({
			external_id: a.external_id,
			label: a.label,
			description: a.description || undefined
		})),
		nodes: nodeFixtures,
		ends: endFixtures,
		nodesById,
		endsById,
		startNode
	};

	const nodePbIdByExternalId = new Map<string, string>();
	const nodeExternalIdByPbId = new Map<string, string>();
	for (const n of nodes) {
		// GraphNode.id est typé `string | number` via D3 SimulationNodeDatum — en BD c'est
		// toujours un string PB id 15-char.
		const pbId = String(n.id);
		if (n.external_id) {
			nodePbIdByExternalId.set(n.external_id, pbId);
			nodeExternalIdByPbId.set(pbId, n.external_id);
		}
	}
	const endPbIdByExternalId = new Map<string, string>();
	const endExternalIdByPbId = new Map<string, string>();
	for (const e of ends) {
		if (e.external_id) {
			endPbIdByExternalId.set(e.external_id, e.id);
			endExternalIdByPbId.set(e.id, e.external_id);
		}
	}

	return {
		compiled,
		nodePbIdByExternalId,
		nodeExternalIdByPbId,
		endPbIdByExternalId,
		endExternalIdByPbId
	};
}

function buildNodeFixture(n: GraphNode): NodeFixture {
	// GraphNode déclare condition/effects/intents comme `unknown` — la cohérence avec
	// le schéma Zod scripted-scenario est garantie au moment de l'import (Phase 4).
	return {
		external_id: n.external_id ?? '',
		titre: n.title,
		texte: n.text,
		is_start: n.is_start,
		consumes_action: n.consumes_action,
		prompt_ia: n.prompt_ia,
		intents: (n.intents as IntentDecl[] | undefined) ?? undefined,
		condition: (n.condition as Condition | null) ?? undefined,
		effects: (n.effects as Effect[] | null) ?? undefined
	};
}

function buildEndFixture(e: End): EndFixture {
	return {
		external_id: e.external_id ?? '',
		title: e.title,
		text: e.text,
		priority: e.priority ?? 0,
		condition: (e.condition as Condition | null) ?? undefined
	};
}

// ─── Bridge : Session PB ⇄ SessionState runtime ──────────────────────────────

export function readStateFromSession(session: Session, bundle: ScenarioBundle): SessionState {
	const currentPbId = (session.current_node ?? null) as string | null;
	const currentExternal = currentPbId
		? bundle.nodeExternalIdByPbId.get(currentPbId) ?? null
		: null;

	const endedPbId = (session.end ?? null) as string | null;
	const endedExternal = endedPbId ? bundle.endExternalIdByPbId.get(endedPbId) ?? null : null;

	return {
		current_node: currentExternal,
		visited_nodes: session.visited_nodes ?? [],
		evidences: session.evidences ?? [],
		scores: session.scores ?? {},
		warnings: session.warnings ?? 0,
		actions_left: session.actions_left ?? null,
		last_intent: session.last_intent ? session.last_intent : null,
		last_classification: session.last_classification ? session.last_classification : null,
		ended_with: session.completed ? endedExternal : null
	};
}

async function persistState(
	pb: MyPocketBase,
	sessionId: string,
	state: SessionState,
	bundle: ScenarioBundle
): Promise<void> {
	const update: Record<string, unknown> = {
		current_node: state.current_node
			? bundle.nodePbIdByExternalId.get(state.current_node) ?? null
			: null,
		visited_nodes: state.visited_nodes,
		evidences: state.evidences,
		scores: state.scores,
		warnings: state.warnings,
		actions_left: state.actions_left,
		last_intent: state.last_intent ?? '',
		last_classification: state.last_classification ?? ''
	};

	if (state.ended_with !== null) {
		update.completed = true;
		const endPbId = bundle.endPbIdByExternalId.get(state.ended_with);
		if (endPbId) update.end = endPbId;
	}

	await pb.collection('Session').update(sessionId, update);
}

// Recompile à partir d'un fixture déjà parsé — exposé pour les tests d'intégration.
// (Le chemin de production passe par `loadScenarioBundle` qui lit la BD.)
export { compile as compileFromFixture };
