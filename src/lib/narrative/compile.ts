// Index un ScriptedScenarioFixture (résultat du parse YAML + validation Zod)
// en CompiledScenario prêt à l'exécution par le moteur.

import type { CompiledScenario, ScriptedScenarioFixture } from './types';

export function compile(raw: ScriptedScenarioFixture): CompiledScenario {
	const scenarioName = raw.scenario.external_id;
	assertUniqueExternalIds(raw.nodes, 'noeud', scenarioName);
	assertUniqueExternalIds(raw.ends, 'fin', scenarioName);
	assertUniqueExternalIds(raw.characters, 'character', scenarioName);
	assertUniqueExternalIds(raw.evidences, 'evidence', scenarioName);
	assertUniqueExternalIds(raw.state_axes, 'state_axis', scenarioName);

	const nodesById = new Map<string, ReturnType<typeof identity>>();
	for (const node of raw.nodes) nodesById.set(node.external_id, node);
	const endsById = new Map<string, ReturnType<typeof identity>>();
	for (const end of raw.ends) endsById.set(end.external_id, end);

	const starts = raw.nodes.filter((n) => n.is_start === true);
	if (starts.length > 1) {
		throw new Error(`scénario "${scenarioName}" : ${starts.length} noeuds is_start=true (attendu : 1)`);
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

function assertUniqueExternalIds(
	collection: ReadonlyArray<{ external_id: string }>,
	type: string,
	scenarioName: string
): void {
	const seen = new Set<string>();
	for (const item of collection) {
		if (seen.has(item.external_id)) {
			throw new Error(
				`scénario "${scenarioName}" : doublon d'external_id de ${type} : ${item.external_id}`
			);
		}
		seen.add(item.external_id);
	}
}

function identity<T>(x: T): T {
	return x;
}
