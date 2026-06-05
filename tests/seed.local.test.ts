// One-shot LOCAL seed so gamemaster scenarios are playable in the browser with zero clicks.
// Drops the previous-iteration schema/data, re-imports db/schema.json, then creates a player
// user + both gamemaster scenarios (3036, helix) + a ready-to-play Session each with its start
// node. Guarded by SEED=1 so it never runs in the normal suite.
//   docker compose up -d pocketbase && SEED=1 pnpm exec vitest run tests/seed.local.ts
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import PocketBase from 'pocketbase';
import { compileScenario } from '../src/lib/scenario/compile';
import { initState } from '../src/lib/server/gamemaster/engine';

const SEED = !!process.env.SEED;
const PB_URL = process.env.DB_URL || 'http://localhost:8090';
const SU_EMAIL = process.env.PB_SU_EMAIL || 'admin@local.dev';
const SU_PASS = process.env.PB_SU_PASS || 'password1234';

const read = (name: string) =>
	readFileSync(new URL(`../scenarios/${name}`, import.meta.url), 'utf-8');

describe.skipIf(!SEED)('local seed', () => {
	it('seeds schema + scenarios + playable sessions', async () => {
		const pb = new PocketBase(PB_URL);
		pb.autoCancellation(false);
		await pb.collection('_superusers').authWithPassword(SU_EMAIL, SU_PASS);

		// 1. Re-import the repo schema, dropping any collection not in it (drops old iteration).
		const schema = JSON.parse(readFileSync(new URL('../db/schema.json', import.meta.url), 'utf-8'));
		await pb.collections.import(schema, true);
		console.log('[seed] schema imported (deleteMissing=true)');

		// 2. Purge leftover records from the previous iteration.
		for (const col of ['Node', 'Session', 'Event', 'End', 'Side', 'Scenario']) {
			const items = await pb.collection(col).getFullList({ fields: 'id' });
			let purged = 0;
			for (const it of items) {
				// Deletes cascade (e.g. removing a Session removes its Nodes), so a record may
				// already be gone by the time we reach it — ignore 404s.
				try {
					await pb.collection(col).delete(it.id);
					purged++;
				} catch (e) {
					if ((e as { status?: number }).status !== 404) throw e;
				}
			}
			if (purged) console.log(`[seed] purged ${purged} from ${col}`);
		}

		// 3. Player user (so sessions have an author; login = player@local.dev / password1234).
		let user;
		try {
			user = await pb.collection('Users').getFirstListItem('username="player"');
		} catch {
			user = await pb.collection('Users').create({
				username: 'player',
				email: 'player@local.dev',
				emailVisibility: true,
				password: 'password1234',
				passwordConfirm: 'password1234',
				role: 'user',
				verified: true
			});
		}
		console.log('[seed] user:', user.id);

		// 4. Each scenario: compile → Scenario(gamemaster) + Narration side → Session + start node.
		const plan = [
			{ file: '3036.yaml', slug: 1, name: '3036 (local)' },
			{ file: 'helix.yaml', slug: 2, name: 'Helix (local)' }
		];
		const urls: string[] = [];
		for (const p of plan) {
			const script = compileScenario(read(p.file));
			const start = script.nodes.find((n) => n.id === 'start');
			if (!start) throw new Error(`${p.file}: no start node`);

			const scenario = await pb.collection('Scenario').create({
				title: script.meta.title,
				prologue: script.prologue,
				lang: script.meta.lang,
				ai: true,
				engine: 'gamemaster',
				script,
				firstNodeTitle: start.title ?? script.meta.title,
				firstNodeText: start.text,
				firstNodeAuthor: script.meta.title
			});
			await pb.collection('Side').create({ scenario: scenario.id, name: 'Narration' });

			const session = await pb.collection('Session').create({
				name: p.name,
				slug: p.slug,
				scenario: scenario.id,
				author: user.id,
				public: true,
				visible: true,
				completed: false,
				useAudio: false,
				state: initState(script)
			});

			await pb.collection('Node').create({
				title: scenario.firstNodeTitle,
				text: scenario.firstNodeText,
				author: scenario.firstNodeAuthor,
				type: 'startNode',
				session: session.id
			});

			urls.push(`  ${p.name}: http://localhost:5173/sessions/${p.slug}`);
			console.log(`[seed] ${p.file} -> scenario ${scenario.id}, session slug ${p.slug}`);
		}
		console.log('\n[seed] DONE. Open in the browser:\n' + urls.join('\n') + '\n');
	}, 120_000);
});
