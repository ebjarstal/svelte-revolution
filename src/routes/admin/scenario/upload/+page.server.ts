import { fail, type Actions } from '@sveltejs/kit';
import PocketBase from 'pocketbase';
import { env } from '$env/dynamic/private';
import { compileScenario, ScenarioCompileError } from '$lib/scenario/compile';

// Admin upload flow for LLM-gamemaster scenarios (design §8). Accepts a `.yaml` file,
// compiles + validates it (compileScenario runs Zod + static integrity checks), and on
// success creates a `Scenario` (engine=gamemaster) carrying the compiled script plus a
// default narration side. Authoring errors are returned to the page and shown inline.
export const actions = {
	uploadScenario: async ({ request }) => {
		const data = await request.formData();

		const pb = new PocketBase(env.DB_URL);
		const pb_cookie = data.get('pb_cookie') as string;
		pb.authStore.loadFromCookie(pb_cookie);

		try {
			await pb.collection('Users').authRefresh();
		} catch {
			return fail(401, { error: 'Unauthorized' });
		}
		if (!pb.authStore.isValid || !pb.authStore.record) {
			return fail(401, { error: 'Unauthorized' });
		}

		const file = data.get('file');
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { issues: ['No YAML file provided.'] });
		}
		const yamlText = await file.text();

		// Compile + validate. ScenarioCompileError carries the list of authoring issues.
		let script;
		try {
			script = compileScenario(yamlText);
		} catch (e) {
			if (e instanceof ScenarioCompileError) {
				return fail(400, { issues: e.issues });
			}
			console.error(e);
			return fail(500, { error: 'Unexpected error while compiling the scenario.' });
		}

		// Mirror the `start` node + prologue into the legacy Scenario fields so the existing
		// prologue UI and createStartNode keep working (design §3).
		const start = script.nodes.find((n) => n.id === 'start');
		if (!start) {
			return fail(400, { issues: ['Compiled script has no start node.'] });
		}

		try {
			const scenario = await pb.collection('Scenario').create({
				title: script.meta.title,
				prologue: script.prologue,
				lang: script.meta.lang,
				ai: true,
				engine: 'gamemaster',
				script,
				sourceYaml: yamlText,
				firstNodeTitle: start.title ?? script.meta.title,
				firstNodeText: start.text,
				firstNodeAuthor: script.meta.title
			});

			try {
				await pb
					.collection('Side')
					.create({ scenario: scenario.id, name: 'Narration' }, { requestKey: null });
			} catch (e) {
				console.error(e);
				await pb.collection('Scenario').delete(scenario.id);
				return fail(500, { error: 'Failed to create the default side.' });
			}

			return { success: true, scenarioId: scenario.id, title: scenario.title };
		} catch (e) {
			console.error(e);
			return fail(500, { error: 'Failed to create the scenario.' });
		}
	}
} satisfies Actions;
