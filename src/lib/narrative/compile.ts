// Index un ScriptedScenarioFixture (résultat du parse YAML + validation Zod)
// en CompiledScenario prêt à l'exécution par le moteur.

import type { CompiledScenario, ScriptedScenarioFixture } from './types';

export function compile(raw: ScriptedScenarioFixture): CompiledScenario {
	const nodesById = new Map<string, ReturnType<typeof identity>>();
	for (const node of raw.nodes) {
		if (nodesById.has(node.external_id)) {
			throw new Error(`scénario "${raw.scenario.external_id}" : doublon d'external_id de noeud : ${node.external_id}`);
		}
		nodesById.set(node.external_id, node);
	}
	const endsById = new Map<string, ReturnType<typeof identity>>();
	for (const end of raw.ends) {
		if (endsById.has(end.external_id)) {
			throw new Error(`scénario "${raw.scenario.external_id}" : doublon d'external_id de fin : ${end.external_id}`);
		}
		endsById.set(end.external_id, end);
	}
	const starts = raw.nodes.filter((n) => n.is_start === true);
	if (starts.length > 1) {
		throw new Error(`scénario "${raw.scenario.external_id}" : ${starts.length} noeuds is_start=true (attendu : 1)`);
	}
	return {
		external_id: raw.scenario.external_id,
		title: raw.scenario.title,
		prologue: raw.scenario.prologue,
		lang: raw.scenario.lang,
		rules: raw.rules,
		characters: raw.characters,
		evidences: raw.evidences,
		state_axes: raw.state_axes,
		nodes: raw.nodes,
		ends: raw.ends,
		nodesById: nodesById as CompiledScenario['nodesById'],
		endsById: endsById as CompiledScenario['endsById'],
		startNode: starts[0] ?? null
	};
}

function identity<T>(x: T): T {
	return x;
}
