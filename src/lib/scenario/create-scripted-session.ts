// Création d'une session scripted (cf. docs/narrative-engine-design.md §3.2 / §7.1).
// Le scénario doit déjà avoir été persisté en BD via `persistCompiledScenario`
// (Phase 4) : tous les Nodes — y compris celui marqué `is_start: true` — existent
// alors comme rows PB. Cette fonction ne crée AUCUN nouveau Node — elle seed
// uniquement l'état runtime initial sur la nouvelle row Session.
//
// Sémantique des champs (cohérent avec `initialState()` de `$lib/narrative/types.ts`) :
//   - current_node : PB id du startNode (champ `relation`, cf. schema.json ligne 1257)
//   - visited_nodes : [startNode.external_id] (champ `json`, cf. design §3.2 ligne 112)
//   - evidences, scores : [] / {} initialement
//   - warnings : 0
//   - actions_left : scenario.rules.initial_actions ?? null
//   - last_intent / last_classification : '' (champs `text` avec max=100)
//
// Module hermétique : ne touche pas au singleton `$lib/client/pocketbase` ni à
// `$env/*`, pour rester testable sous Vitest sans alias SvelteKit.

import type { Session } from '$types/pocketBase/TableTypes';
import type { MyPocketBase } from '$types/pocketBase';

export type CreateScriptedSessionInput = Pick<
	Session,
	'name' | 'author' | 'scenario' | 'image' | 'useAudio'
>;

export async function createScriptedSession(
	pb: MyPocketBase,
	input: CreateScriptedSessionInput
): Promise<Session> {
	const scenario = await pb.collection('Scenario').getOne(input.scenario);
	if (scenario.engine !== 'scripted') {
		throw new Error(
			`createScriptedSession appelé sur un scénario engine="${scenario.engine ?? 'free'}"`
		);
	}

	const startNode = await pb
		.collection('Node')
		.getFirstListItem(`scenario="${input.scenario}" && is_start=true`, {
			fields: 'id,external_id'
		});

	const sessions = await pb.collection('Session').getFullList({ fields: 'id, slug' });
	const slug = sessions.length ? Math.max(...sessions.map((s) => s.slug || 0)) + 1 : 1;

	return await pb.collection('Session').create({
		name: input.name,
		scenario: input.scenario,
		author: input.author,
		slug,
		public: true,
		visible: true,
		completed: false,
		image: input.image,
		useAudio: input.useAudio,
		current_node: startNode.id,
		visited_nodes: startNode.external_id ? [startNode.external_id] : [],
		evidences: [],
		scores: {},
		warnings: 0,
		actions_left: scenario.rules?.initial_actions ?? null,
		last_intent: '',
		last_classification: ''
	});
}
