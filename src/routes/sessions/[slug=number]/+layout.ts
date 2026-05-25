import { getSession } from '$lib/sessions';
import { pb } from '$lib/client/pocketbase';
import { error, type ServerLoad } from '@sveltejs/kit';

import type { Evidence, GraphNode, Scenario, Session, StateAxis } from '$types/pocketBase/TableTypes';
import type { AdminInfo } from '$stores/session.svelte';

export interface ScriptedLayoutData {
	currentNode: GraphNode | null;
	evidences: Evidence[];
	stateAxes: StateAxis[];
}

export const load: ServerLoad = async ({ params, fetch }) => {
	const session = await getSession(Number(params.slug));
	const scenario = session.expand?.scenario || null;
	if (!scenario) {
		error(500, {
			status: 500,
			message: 'No scenario for session'
		});
	}

	const sides = await getSides(session.scenario);

	let aiConnected = false;
	if (session.expand?.scenario?.ai) {
		const aiHealty = await fetch('/api/ai/health', { method: 'POST' })
			.then((res) => res.json())
			.then((res) => res.aiHealthy);
		aiConnected = aiHealty && session.expand?.scenario?.ai;
	}

	const nodes = pb
		.collection('Node')
		.getFullList({ filter: pb.filter('session = {:session}', { session: session.id }), expand: 'side' });

	// Phase 5.5 — données spécifiques au moteur scripted (current node + taxonomies de
	// preuves et axes pour afficher des labels lisibles dans la sidebar). Promise resolved
	// à null pour les sessions free → la page rendra MainGraph comme avant.
	const scriptedData: Promise<ScriptedLayoutData | null> =
		scenario.engine === 'scripted' ? loadScriptedData(session, scenario) : Promise.resolve(null);

	return {
		ai: {
			connected: aiConnected
		},
		admin: {
			...await adminCheck(session),
		},
		session,
		scenario,
		sides,
		nodesPromise: nodes,
		scriptedDataPromise: scriptedData,
	};
};

async function loadScriptedData(session: Session, scenario: Scenario): Promise<ScriptedLayoutData> {
	const [currentNode, evidences, stateAxes] = await Promise.all([
		session.current_node
			? pb.collection('Node').getOne(session.current_node).catch(() => null)
			: Promise.resolve(null),
		pb.collection('Evidences').getFullList({
			filter: pb.filter('scenario = {:scenario}', { scenario: scenario.id })
		}),
		pb.collection('StateAxes').getFullList({
			filter: pb.filter('scenario = {:scenario}', { scenario: scenario.id })
		})
	]);
	return { currentNode, evidences, stateAxes };
}

async function adminCheck(sessionData: Session): Promise<AdminInfo> {
	if (sessionData.author === pb.authStore.record?.id || pb.authStore.record?.role === 'superAdmin') {
		if (pb.authStore.isValid) {
			const scenario = sessionData.scenario;
			return {
				isAdmin: true,
				events: await pb.collection('Event').getFullList({
					filter: pb.filter('scenario = {:scenario}', { scenario })
				}),
				ends: await pb.collection('End').getFullList({
					filter: pb.filter('scenario = {:scenario}', { scenario })
				}),
			};
		}
	}
	return {
		isAdmin: false,
		events: null,
		ends: null
	};
}

async function getSides(scenarioId: string) {
	const sidesFromDb = await pb.collection('Side').getFullList({
		filter: pb.filter('scenario = {:scenario}', { scenario: scenarioId })
	});
	const sides = sidesFromDb.map((side, i) => {
		return {
			id: side.id,
			name: side.name,
			number: i
		};
	});
	return sides;
}
