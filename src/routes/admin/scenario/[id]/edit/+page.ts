import { error } from '@sveltejs/kit';
import { pb } from '$lib/client/pocketbase';
import type { Scenario } from '$types/pocketBase/TableTypes';
import type { PageLoad } from './$types';

// Client-side load (the admin area is ssr=false and auth lives in the client pb.authStore).
// Only gamemaster scenarios carry an editable compiled `script`.
export const load: PageLoad = async ({ params }) => {
	let scenario: Scenario;
	try {
		scenario = await pb.collection('Scenario').getOne<Scenario>(params.id);
	} catch {
		error(404, { status: 404, message: 'Scenario not found' });
	}
	if (scenario.engine !== 'gamemaster' || !scenario.script) {
		error(400, { status: 400, message: 'This scenario has no editable gamemaster script.' });
	}
	return { scenario };
};
