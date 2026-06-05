// One-shot local bootstrap for the manual gamemaster run: import the repo schema and create a
// superAdmin app user. Does NOT create scenarios/sessions — those are created via the admin UI.
//   node tests/bootstrap.local.mjs
import { readFileSync } from 'node:fs';
import PocketBase from 'pocketbase';

const PB_URL = process.env.DB_URL || 'http://localhost:8090';
const pb = new PocketBase(PB_URL);
pb.autoCancellation(false);

await pb.collection('_superusers').authWithPassword('admin@local.dev', 'password1234');

// Import the repo schema (deleteMissing drops any leftover collection from a prior iteration).
const schema = JSON.parse(readFileSync(new URL('../db/schema.json', import.meta.url), 'utf-8'));
await pb.collections.import(schema, true);
console.log('[bootstrap] schema imported');

// superAdmin app user so all admin tabs are reachable; login = admin@local.dev / password1234.
let user;
try {
	user = await pb.collection('Users').getFirstListItem('email="admin@local.dev"');
	console.log('[bootstrap] app user already exists:', user.id);
} catch {
	user = await pb.collection('Users').create({
		username: 'admin',
		email: 'admin@local.dev',
		emailVisibility: true,
		password: 'password1234',
		passwordConfirm: 'password1234',
		role: 'superAdmin',
		verified: true
	});
	console.log('[bootstrap] created superAdmin app user:', user.id);
}
console.log('[bootstrap] DONE');
