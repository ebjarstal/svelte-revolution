import { describe, expect, test } from 'vitest';
import { pbId } from '../../../src/lib/scenario/pb-id';

describe('pbId', () => {
	test('respecte le pattern PocketBase ^[a-z0-9]{15}$', () => {
		for (let i = 0; i < 1000; i++) {
			const id = pbId();
			expect(id).toMatch(/^[a-z0-9]{15}$/);
		}
	});

	test('1000 IDs générés en série sont uniques (pas de collision dans un batch)', () => {
		const ids = new Set<string>();
		for (let i = 0; i < 1000; i++) {
			ids.add(pbId());
		}
		expect(ids.size).toBe(1000);
	});
});
