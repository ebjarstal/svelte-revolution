import { pb } from '$lib/client/pocketbase';
import type { Scenario } from '$types/pocketBase/TableTypes';
import type { PageLoad } from './$types';

export const load: PageLoad = async () => {
	const scenarios = await pb.collection('Scenario').getFullList<Scenario>({ sort: '-created' });
	return { scenarios };
};
