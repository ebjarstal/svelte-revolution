import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Classifier } from '../../src/lib/scenario/script.schema';

// Offline coverage for the §7 retry + fallback logic (no network). We mock the Mistral SDK so
// `chat.parse` returns whatever the test scripts, then assert classify()'s attempt count and result.
// `vi.hoisted` is required: vi.mock is hoisted above module imports, so the factory can only close
// over variables that are themselves hoisted.
const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock('@mistralai/mistralai', () => ({
	// A class (not vi.fn) so `new Mistral()` reliably yields an instance whose `chat.parse`
	// is our stub — a vi.fn used as a constructor does not return the factory's object.
	Mistral: class {
		chat = { parse };
	}
}));

import { classify } from '../../src/lib/server/gamemaster/mistral';

const classifier: Classifier = {
	instructions: 'classify',
	output: { label: [{ id: 'A' }, { id: 'B' }] }
};

const reply = (parsed: unknown) => ({ choices: [{ message: { parsed } }] });

beforeEach(() => {
	process.env.MISTRAL_API_KEY = 'test-key';
	parse.mockReset();
});

describe('classify — retry & fallback (offline, mocked SDK)', () => {
	it('returns the parsed decision on first success (no retry)', async () => {
		parse.mockResolvedValueOnce(reply({ label: 'A' }));
		expect(await classify(classifier, 'hi')).toEqual({ label: 'A' });
		expect(parse).toHaveBeenCalledTimes(1);
	});

	it('retries schema-invalid output, then falls back to {} after 1 initial + 2 retries', async () => {
		parse.mockResolvedValue(reply({ label: 'NOT_IN_ENUM' })); // never validates
		expect(await classify(classifier, 'hi')).toEqual({});
		expect(parse).toHaveBeenCalledTimes(3);
	});

	it('retries thrown errors, then falls back to {}', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		parse.mockRejectedValue(new Error('network down'));
		expect(await classify(classifier, 'hi')).toEqual({});
		expect(parse).toHaveBeenCalledTimes(3);
		spy.mockRestore();
	});

	it('recovers when a later attempt returns valid output', async () => {
		parse
			.mockResolvedValueOnce(reply({ label: 'BAD' })) // invalid → retry
			.mockResolvedValueOnce(reply({ label: 'B' })); // valid → return
		expect(await classify(classifier, 'hi')).toEqual({ label: 'B' });
		expect(parse).toHaveBeenCalledTimes(2);
	});
});
