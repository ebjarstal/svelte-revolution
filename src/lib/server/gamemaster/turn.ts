// Wires the deterministic gamemaster engine into a live session (design §6, Phase 5).
// Given a player's freshly-stored contribution, this runs ONE turn: classify the text with
// Mistral, advance the engine, persist the new `Session.state`, and create the authored
// response node(s) (and ending prose) in the graph so realtime re-renders the dialogue.
//
// The engine itself stays PocketBase-free and fully unit-tested; this module is the only place
// that touches both the engine and the database.

import { createNode } from '$lib/nodes';
import type { MyPocketBase } from '$types/pocketBase';
import type { Session } from '$types/pocketBase/TableTypes';
import type { Classifier } from '$lib/scenario/script.schema';
import type { CompiledScript } from '$lib/scenario/compile';
import { classify } from './mistral';
import { initState, step, type RuntimeState, type LlmDecision } from './engine';
import { env } from '$env/dynamic/private';

// Thrown when the classifier exhausted its retries (Mistral unreachable / bad key). The caller
// rolls back the contribution and tells the player the game master is temporarily unavailable,
// rather than letting the turn silently advance via a default transition or make no move at all.
export class GamemasterUnavailableError extends Error {
	constructor() {
		super('gamemaster turn: Mistral classification failed after retries');
		this.name = 'GamemasterUnavailableError';
	}
}

// Run a single gamemaster turn for a player's contribution (already stored as a 'contribution'
// node). Creates the authored response node(s) parented under it and closes the session on an ending.
// The public `addNode` action talks to PocketBase unauthenticated (play needs no login), but
// `Session.updateRule` requires auth. Persisting game state is a privileged server-side write, so
// we authenticate this request-scoped client as a PocketBase superuser using server-only env creds
// (PB_SUPERUSER_EMAIL / PB_SUPERUSER_PASSWORD). This keeps Session writes locked down in production
// while letting anonymous players advance the engine.
export async function ensureWriteAuth(pb: MyPocketBase): Promise<void> {
	if (pb.authStore.isValid) return;
	const email = env.PB_SUPERUSER_EMAIL;
	const password = env.PB_SUPERUSER_PASSWORD;
	if (!email || !password) {
		throw new Error(
			'gamemaster turn: PB_SUPERUSER_EMAIL/PB_SUPERUSER_PASSWORD are not set; cannot persist Session.state'
		);
	}
	try {
		await pb.collection('_superusers').authWithPassword(email, password);
	} catch (e) {
		// Creds are present but rejected — almost always a config mismatch (no _superusers account
		// matches them). Surface that explicitly instead of the raw "Failed to authenticate", which
		// reads like the player's request was unauthorized.
		throw new Error(
			'gamemaster turn: PB_SUPERUSER_EMAIL/PB_SUPERUSER_PASSWORD did not match any PocketBase superuser; cannot persist Session.state',
			{ cause: e }
		);
	}
}

export async function runGamemasterTurn(
	pb: MyPocketBase,
	session: Session,
	contributionId: string,
	contributionText: string
): Promise<void> {
	const scenario = session.expand?.scenario;
	const script = scenario?.script;
	if (!script) throw new Error('gamemaster turn: session scenario has no compiled script');

	// Seed per-session state lazily on the first turn. This is the chosen seeding point (over
	// creation-time seeding) because createSession runs client-side and cannot import the
	// server-only engine. A blank/missing state — null, or a stray empty object from the json
	// column — falls back to a fresh initState.
	const state: RuntimeState =
		session.state && typeof session.state.currentNode === 'string'
			? session.state
			: initState(script);
	if (state.ended) return; // session already over — ignore further input

	await ensureWriteAuth(pb); // privileged client for Session.state writes

	const classifier = classifierForCurrentNode(script, state);
	let decision: LlmDecision = {};
	if (classifier) {
		decision = await classify(classifier, contributionText);
		// A successful classification always carries a label; classify() returns {} (no label)
		// only after exhausting its retries — i.e. Mistral is down. Make that explicit to the
		// player instead of silently advancing. (Classifier-less narration nodes keep using {}.)
		if (decision.label === undefined) {
			throw new GamemasterUnavailableError();
		}
	}

	const result = step(script, state, decision);

	// Persist the mutated state. Single-protagonist sessions (design §3) ⇒ a direct write is enough.
	await pb.collection('Session').update(session.id, { state });

	// Narration author mirrors the start node's narrator (ARGO / ARIA).
	const author = scenario.firstNodeAuthor || scenario.title || 'MJ';

	// Chain the authored response node(s) under the contribution, in display order.
	let parent = contributionId;
	for (const node of result.created) {
		const created = await createNode(pb, {
			title: node.title ?? '',
			text: node.text,
			author,
			session: session.id,
			parent,
			type: 'event',
			side: null,
			audio: null
		});
		parent = String(created.id);
	}

	// On an ending, show its prose and close the session.
	if (result.ending) {
		await createNode(pb, {
			title: result.ending.title,
			text: result.ending.text,
			author,
			session: session.id,
			parent,
			type: 'event',
			side: null,
			audio: null
		});
		await pb.collection('Session').update(session.id, { completed: true });
	}
}

// The classifier to run this turn: the current node's local decision classifier, falling back
// to the global decision's classifier (helix nodes that rely on the global hub). Both 3036 and
// helix always resolve one; returns undefined only on an authoring gap (then no LLM call).
function classifierForCurrentNode(
	script: CompiledScript,
	state: RuntimeState
): Classifier | undefined {
	const node = script.nodes.find((n) => n.id === state.currentNode);
	const decRef = node?.decision;
	const dec = typeof decRef === 'string' ? script.decisions[decRef] : decRef;
	const classifierId = dec?.classifier ?? script.global?.decision.classifier;
	return classifierId ? script.classifiers[classifierId] : undefined;
}
