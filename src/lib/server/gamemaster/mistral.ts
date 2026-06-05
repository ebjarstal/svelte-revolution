// Real Mistral classifier calls for the LLM-gamemaster engine. See docs/llm-gamemaster-design.md §7.
// Turns an authored `Classifier` into a strict structured-output call and returns a constrained
// `LlmDecision`. Bounded retry (≤2) on schema-invalid output; on hard failure it returns an empty
// decision `{}`, which the engine matches only against an unconditional (`when`-less) transition —
// so a hard failure advances the session only where the scenario declares such a catch-all
// (§7 "declared default transition"); otherwise the turn makes no move and the caller must handle it.

import { Mistral } from '@mistralai/mistralai';
import { z } from 'zod';
import type { Classifier } from '$lib/scenario/script.schema';
import type { LlmDecision } from './engine';

const MODEL = 'mistral-small-latest'; // cheap, strict-schema capable (design §7)
const MAX_ATTEMPTS = 3; // 1 initial call + ≤2 retries

let client: Mistral | undefined;

function getClient(): Mistral {
	if (!client) {
		const apiKey = process.env.MISTRAL_API_KEY;
		if (!apiKey) throw new Error('MISTRAL_API_KEY is not set');
		client = new Mistral({ apiKey });
	}
	return client;
}

type EnumField = { nullable?: boolean; values: string[] };

function enumOf(values: string[]) {
	return z.enum(values as [string, ...string[]]);
}

// A strict Zod object mirroring the classifier's declared output enums (label + optional
// target / evidencePresented). Used as the Mistral responseFormat and to re-validate the result.
export function decisionSchema(classifier: Classifier): z.ZodType<LlmDecision> {
	const { label, target, evidencePresented } = classifier.output;

	const enumField = (f: EnumField) => (f.nullable ? enumOf(f.values).nullable() : enumOf(f.values));

	const shape: Record<string, z.ZodTypeAny> = { label: enumOf(label.map((l) => l.id)) };
	if (target) shape.target = enumField(target);
	if (evidencePresented) shape.evidencePresented = enumField(evidencePresented);

	return z.object(shape) as unknown as z.ZodType<LlmDecision>;
}

// Classify one player contribution against a classifier. Returns the constrained decision, or an
// empty decision `{}` on hard failure (which selects a `when`-less/default transition if one exists).
export async function classify(
	classifier: Classifier,
	contributionText: string
): Promise<LlmDecision> {
	const schema = decisionSchema(classifier);

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const res = await getClient().chat.parse({
				model: MODEL,
				temperature: 0,
				maxTokens: 256,
				responseFormat: schema,
				messages: [
					{ role: 'system', content: classifier.instructions },
					{ role: 'user', content: contributionText }
				]
			});
			// Re-validate ourselves: `parsed` may be null when the model's output failed the schema.
			const check = schema.safeParse(res.choices?.[0]?.message?.parsed);
			if (check.success) return check.data;
		} catch (err) {
			if (attempt === MAX_ATTEMPTS) {
				console.error('[gamemaster] Mistral classify failed after retries:', err);
			}
		}
	}

	return {}; // hard failure → empty decision; routes to a declared unconditional transition if any (§7)
}

// Lightweight readiness probe: confirms the key is set and the API answers a trivial classification.
export async function healthCheck(): Promise<{ ok: boolean; model: string; error?: string }> {
	const probe: Classifier = {
		instructions: 'You are a health check. Always reply with label OK.',
		output: { label: [{ id: 'OK' }] }
	};
	const schema = decisionSchema(probe);
	try {
		const res = await getClient().chat.parse({
			model: MODEL,
			temperature: 0,
			maxTokens: 16,
			responseFormat: schema,
			messages: [
				{ role: 'system', content: probe.instructions },
				{ role: 'user', content: 'ping' }
			]
		});
		const decision = schema.parse(res.choices?.[0]?.message?.parsed);
		return { ok: decision.label === 'OK', model: MODEL };
	} catch (err) {
		return { ok: false, model: MODEL, error: (err as Error).message };
	}
}
