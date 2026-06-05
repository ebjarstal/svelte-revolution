import { createNode } from '$lib/nodes';
import { censorNode } from '$lib/server/ia';
import { createNewEvents, triggerEnd } from '$lib/server/ia/event';
import { runGamemasterTurn, ensureWriteAuth } from '$lib/server/gamemaster/turn';
import { addNodeSchema } from '$lib/zschemas/addNode.schema';
import PocketBase from 'pocketbase';
import { env } from '$env/dynamic/private';
import { ClientResponseError } from 'pocketbase';
import type { GraphNode, Session } from '$types/pocketBase/TableTypes';
import { type Actions, fail } from '@sveltejs/kit';

export const actions: Actions = {
	addNode: async ({ request }) => {
		try {
			const data = await request.formData();

			const pb = new PocketBase(env.DB_URL);

			// * no needs to authenticate, as the session is public

			let nodeData = {
				title: data.get('title') as string,
				text: data.get('text') as string,
				author: data.get('author') as string,
				parent: data.get('parent') as string,
				session: data.get('session') as string,
				side: data.get('side') as string,
				audio: (data.get('audio') ?? null) as File | null
			};

			const validation = addNodeSchema.safeParse(nodeData);
			if (!validation.success) {
				return fail(422, {
					success: false,
					error: validation.error.issues.map(e => e.message).join(', ')
				});
			}

			// maybe cache the session data to avoid a round trip on every added node
			const sessionData = await pb
				.collection('Session')
				.getOne<Session>(nodeData.session, { expand: 'scenario' });
			const isGamemaster = sessionData.expand?.scenario?.engine === 'gamemaster';
			let censorResponse: Awaited<ReturnType<typeof censorNode>> | null = null;
			if (!isGamemaster && sessionData.expand?.scenario?.ai) {
				censorResponse = await censorNode(nodeData);
				nodeData = { ...nodeData, ...censorResponse.node };
			}

			if (isGamemaster) {
				// Persisting engine state needs a PocketBase superuser. Authenticate up-front — before
				// the contribution is created — so a misconfigured superuser fails cleanly instead of
				// leaving an orphan contribution with no narration response. (The play client is
				// otherwise unauthenticated, which is also why the rollback below can delete the node.)
				try {
					await ensureWriteAuth(pb);
				} catch (e) {
					console.error('gamemaster auth failed:', e);
					return fail(502, {
						success: false,
						error: 'The game master could not respond. Please try again.',
						errorKey: 'inSession.gamemasterUnavailable'
					});
				}
			}

			const node = await createNode(
				pb,
				{
					title: nodeData.title,
					text: nodeData.text,
					author: nodeData.author,
					session: nodeData.session,
					parent: nodeData.parent,
					type: 'contribution',
					side: nodeData.side,
					audio: nodeData.audio
				}
			);
			if (isGamemaster) {
				// Deterministic engine + Mistral classification produce the authored response node(s).
				// Auth already succeeded above and classify() swallows Mistral errors (returns {}), so a
				// throw here means the engine step or a PocketBase write failed after the contribution
				// was stored — roll it back (pb is authenticated) to keep the graph consistent with
				// engine state and let the player retry without stacking orphan nodes.
				try {
					await runGamemasterTurn(pb, sessionData, String(node.id), nodeData.text);
				} catch (e) {
					console.error('gamemaster turn failed:', e);
					try {
						await pb.collection('Node').delete(String(node.id));
					} catch (rollbackErr) {
						console.error('failed to roll back contribution node:', rollbackErr);
					}
					return fail(502, {
						success: false,
						error: 'The game master could not respond. Please try again.',
						errorKey: 'inSession.gamemasterUnavailable'
					});
				}
			}
			if (censorResponse) {
			  if (censorResponse?.triggerEvent && censorResponse.events) {
				  try {
					  await createNewEvents(pb, nodeData.session, censorResponse.events, node);
				  } catch (e) {
					  // TODO: Handle error
					  console.error(e);
				  }
			  }

			  if (censorResponse?.triggerEnd) {
				  try {
					  await triggerEnd(pb, nodeData.session, censorResponse.triggerEnd);
				  } catch (e) {
					  console.error(e);
				  }
			  }
			}
			
			return {
				status: 200,
				success: true,
				body: { message: 'Node added', node: JSON.stringify(node) }
			};
		} catch (e) {
			console.error(e);
			
			if (e instanceof ClientResponseError) {
				if (e.data.data?.audio?.code === 'validation_file_size_limit') {
					return fail(413,
						{succes: false, error: e.data.data?.audio?.message}
					);
				}
				return fail(400, { 
					success: false, 
					error: e.message
				});
			}
			return fail(500, { success: false, error: 'Error while adding node' });
		}
	},
	// Admin only
	addEvent: async ({ request }) => {
		const data = await request.formData();
		const eventId = data.get('eventId') as string;
		const sessionId = data.get('session') as string;
		const pb_cookie = data.get('pb_cookie') as string;

		const pb = new PocketBase(env.DB_URL);
		pb.authStore.loadFromCookie(pb_cookie);

		// check if user is superAdmin or author
		if (pb.authStore.record?.role !== 'superAdmin') {
			const session = await pb.collection('Session').getOne(sessionId, { fields: 'author' });
			if (session.author !== pb.authStore.record?.id) {
				return fail(401, { success: false, error: 'Unauthorized' });
			}
		}

		if (!sessionId) {
			return fail(500, { success: false, error: 'Not in a session' });
		}
		if (!eventId) {
			return fail(422, { success: false, error: 'Missing event field' });
		}

		let createdEventNode: GraphNode | null = null;
		try {
			const { title, text, author } = await pb.collection('Event').getOne(eventId);
			const firstNode = await pb.collection('Node').getFirstListItem(
				pb.filter('type = {:type} && session = {:session}', {
					session: sessionId,
					type: 'startNode'
				})
			);
			createdEventNode = await createNode(
				pb,
				{
					title,
					text,
					author,
					session: sessionId,
					parent: String(firstNode.id),
					type: 'event',
					side: null
				}
			);
			await pb.collection('Session').update(sessionId, { events: eventId });
		} catch (error) {
			if (error instanceof ClientResponseError) {
				console.error('Error creating event:', error.toJSON());
				if (createdEventNode) {
					await pb.collection('Node').delete(String(createdEventNode.id));
				}
			}
			return fail(500, { success: false, error: 'Error while creating event' });
		}

		return {
			status: 200,
			success: true,
			body: { message: 'Event added', event: createdEventNode }
		};
	},
	endSession: async ({ request }) => {
		const data = await request.formData();
		const sessionId = data.get('session') as string;
		const endId = data.get('endId') as string;
		const pb_cookie = data.get('pb_cookie') as string;

		const pb = new PocketBase(env.DB_URL);
		pb.authStore.loadFromCookie(pb_cookie);

		// check if user is superAdmin or author
		if (pb.authStore.record?.role !== 'superAdmin') {
			const session = await pb.collection('Session').getOne(sessionId, { fields: 'author' });
			if (session.author !== pb.authStore.record?.id) {
				return fail(401, { success: false, error: 'Unauthorized' });
			}
		}

		if (!sessionId) {
			return fail(500, { success: false, error: 'Not in a session' });
		}
		if (!endId) {
			return fail(422, { success: false, error: 'Missing required fields' });
		}

		try {
			await pb.collection('Session').update(sessionId, {
				completed: true,
				end: endId
			});
		} catch (error) {
			console.error('Error ending session:', JSON.stringify(error));
			return fail(500, { success: false, error: 'Error while ending session' });
		}

		return {
			status: 200,
			success: true,
			body: { message: 'Session ended' }
		};
	}
};
