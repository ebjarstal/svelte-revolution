import { fail, type Actions } from '@sveltejs/kit';
import PocketBase from 'pocketbase';
import { DB_URL } from '$env/static/private';
import { compile, parseYaml } from '$lib/narrative';
import { scriptedScenarioSchema } from '$lib/zschemas/scripted-scenario.schema';
import { validateReferences } from '$lib/scenario/validate-references';
import { persistCompiledScenario, BatchPersistError } from '$lib/scenario/persist-scripted';
import type { MyPocketBase } from '$types/pocketBase';

type ImportFailStage = 'auth' | 'missing' | 'parse' | 'zod' | 'compile' | 'refs' | 'persist';

interface ImportSuccess {
	success: true;
	scenarioId: string;
	counts: {
		nodes: number;
		characters: number;
		evidences: number;
		stateAxes: number;
		ends: number;
	};
}

export const actions = {
	importFixture: async ({ request }) => {
		const data = await request.formData();
		const pb_cookie = data.get('pb_cookie') as string | null;
		const file = data.get('fixture');

		const pb = new PocketBase(DB_URL) as MyPocketBase;
		if (pb_cookie) pb.authStore.loadFromCookie(pb_cookie);

		if (!pb.authStore.isValid || pb.authStore.record?.role !== 'superAdmin') {
			return fail(401, { stage: 'auth' satisfies ImportFailStage });
		}

		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { stage: 'missing' satisfies ImportFailStage });
		}

		const text = await file.text();

		let parsed: unknown;
		try {
			parsed = parseYaml(text);
		} catch (err) {
			return fail(400, { stage: 'parse' satisfies ImportFailStage, message: errorMessage(err) });
		}

		const zodResult = scriptedScenarioSchema.safeParse(parsed);
		if (!zodResult.success) {
			return fail(400, {
				stage: 'zod' satisfies ImportFailStage,
				issues: zodResult.error.issues.map((i) => ({
					path: i.path.join('.'),
					message: i.message
				}))
			});
		}

		let compiled;
		try {
			compiled = compile(zodResult.data);
		} catch (err) {
			return fail(400, { stage: 'compile' satisfies ImportFailStage, message: errorMessage(err) });
		}

		const refIssues = validateReferences(compiled);
		if (refIssues.length > 0) {
			return fail(400, {
				stage: 'refs' satisfies ImportFailStage,
				issues: refIssues
			});
		}

		try {
			const { scenarioId } = await persistCompiledScenario(pb, compiled, pb.authStore.record.id);
			return {
				success: true,
				scenarioId,
				counts: {
					nodes: compiled.nodes.length,
					characters: compiled.characters.length,
					evidences: compiled.evidences.length,
					stateAxes: compiled.state_axes.length,
					ends: compiled.ends.length
				}
			} satisfies ImportSuccess;
		} catch (err) {
			const message = err instanceof BatchPersistError ? err.message : errorMessage(err);
			console.error('[admin/scenario/import] persist failed:', err);
			if (err instanceof BatchPersistError && err.cause) {
				const cause = err.cause as { status?: unknown; data?: unknown; response?: unknown };
				console.error('[admin/scenario/import] cause.status:', cause.status);
				console.error('[admin/scenario/import] cause.data:', JSON.stringify(cause.data, null, 2));
			}
			return fail(500, { stage: 'persist' satisfies ImportFailStage, message });
		}
	}
} satisfies Actions;

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
