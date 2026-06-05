import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileScenario } from '../../src/lib/scenario/compile';
import { classify, healthCheck, decisionSchema } from '../../src/lib/server/gamemaster/mistral';
import { initState, step } from '../../src/lib/server/gamemaster/engine';
import type { Classifier } from '../../src/lib/scenario/script.schema';

// Live Mistral integration check (design §7). OFF by default — these make real, billed network
// calls — so the standard `pnpm test:unit` stays offline and deterministic. Opt in explicitly:
//   MISTRAL_LIVE=1 pnpm test:unit run gamemaster-mistral
// The API key is read from .env.local (the same file the app uses), so no extra setup is needed.
const LIVE = !!process.env.MISTRAL_LIVE;

beforeAll(() => {
	if (!LIVE || process.env.MISTRAL_API_KEY) return;
	const text = readFileSync(new URL('../../.env.local', import.meta.url), 'utf-8');
	for (const line of text.split('\n')) {
		const m = line.match(/^([A-Z_]+)=(.*)$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
	}
});

const read = (name: string) =>
	readFileSync(new URL(`../../scenarios/${name}`, import.meta.url), 'utf-8');

describe.skipIf(!LIVE)('gamemaster Mistral — live integration (§7)', () => {
	it('health check: the API answers a trivial classification', async () => {
		const res = await healthCheck();
		expect(res.error).toBeUndefined();
		expect(res.ok).toBe(true);
	}, 30_000);

	it('a live turn classifies a contribution and routes the engine forward', async () => {
		const script = compileScenario(read('3036.yaml'));
		const state = initState(script);

		// Resolve the classifier behind the current (start) node's decision.
		const node = script.nodes.find((n) => n.id === state.currentNode)!;
		const dec = typeof node.decision === 'string' ? script.decisions[node.decision] : node.decision!;
		const classifier: Classifier = script.classifiers[dec.classifier];

		const decision = await classify(
			classifier,
			"Oui, j'accepte de coopérer pleinement avec la procédure."
		);

		// Classification: the label is one the classifier actually declares, and the whole object
		// conforms to that classifier's strict per-output schema.
		expect(classifier.output.label.map((l) => l.id)).toContain(decision.label);
		expect(decisionSchema(classifier).safeParse(decision).success).toBe(true);

		// Routing: feeding that decision to the deterministic engine advances it past `start`.
		const result = step(script, state, decision);
		expect(result.created.length).toBeGreaterThan(0);
		expect(state.currentNode).not.toBe('start');
	}, 30_000);
});
