// Tests du client TS `/api/classify` (Phase 6).
// Cible le cœur hermétique (`classify-core.ts`) pour éviter la résolution des
// virtual modules SvelteKit (`$env/dynamic/private`) sous Vitest — même pattern
// que `engine-dispatch.test.ts`.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createClassifyWord2vec } from '../../../src/lib/server/ia/classify-core';
import type { IntentDecl } from '../../../src/lib/narrative';

const intents: IntentDecl[] = [
	{ label: 'SYSTEME', description: 'reparer le terminal' },
	{ label: 'COMPRENDRE', description: 'comprendre la situation' }
];

describe('createClassifyWord2vec — payload et mapping de la réponse', () => {
	let fetchSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchSpy = vi.fn();
		// @ts-expect-error — override globally for the test
		global.fetch = fetchSpy;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test('POST sur /api/classify avec payload §6.1', async () => {
		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ intent: 'SYSTEME', confidence: 0.82 })
		});
		const classify = createClassifyWord2vec('http://ia.test');

		const result = await classify('je veux reparer le terminal', 'prompt IA du noeud', intents);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toBe('http://ia.test/api/classify');
		expect(init.method).toBe('POST');
		expect(init.headers['Content-Type']).toBe('application/json');

		const body = JSON.parse(init.body);
		expect(body).toMatchObject({
			session: '',
			node_prompt: 'prompt IA du noeud',
			intents,
			player_text: 'je veux reparer le terminal',
			session_state: {}
		});

		expect(result).toEqual({ intent: 'SYSTEME', confidence: 0.82 });
	});

	test('Phase 7 : propage `classification` depuis le payload Go (résout dette 3036)', async () => {
		// Le backend LLM Mistral peut poser `classification` (taxonomie 3036) ; le
		// client TS ne distingue PAS LLM vs word2vec côté serveur Go (même endpoint),
		// donc il doit propager le champ chaque fois qu'il est non-vide.
		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ intent: 'REPONDRE', confidence: 0.9, classification: 'CONFORME' })
		});
		const classify = createClassifyWord2vec('http://ia.test');
		const result = await classify('le chien aboie', '', intents);
		expect(result).toEqual({ intent: 'REPONDRE', confidence: 0.9, classification: 'CONFORME' });
	});

	test("Pas de classification dans le payload Go → champ absent du résultat", async () => {
		// Backend word2vec ne pose jamais classification → le champ doit rester absent
		// pour que les conditions `classification_is:` retombent en no-match plutôt
		// qu'en match sur chaîne vide.
		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ intent: 'SYSTEME', confidence: 0.5 })
		});
		const classify = createClassifyWord2vec('http://ia.test');
		const result = await classify('texte', '', intents);
		expect(result).not.toHaveProperty('classification');
	});

	test('classification vide string → champ omis du résultat', async () => {
		// Mistral peut renvoyer "classification":"" quand non pertinent ; on ne
		// propage pas une chaîne vide (équivalent à pas de classification).
		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ intent: 'SYSTEME', confidence: 0.5, classification: '' })
		});
		const classify = createClassifyWord2vec('http://ia.test');
		const result = await classify('texte', '', intents);
		expect(result).not.toHaveProperty('classification');
	});

	test('Réponse sans confidence numérique → 0', async () => {
		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ intent: 'COMPRENDRE' })
		});
		const classify = createClassifyWord2vec('http://ia.test');
		const result = await classify('texte', '', intents);
		expect(result).toEqual({ intent: 'COMPRENDRE', confidence: 0 });
	});

	test('Réponse sans intent → chaîne vide', async () => {
		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => ({ confidence: 0.3 })
		});
		const classify = createClassifyWord2vec('http://ia.test');
		const result = await classify('texte', '', intents);
		expect(result.intent).toBe('');
	});
});

describe('createClassifyWord2vec — fallbacks no-match', () => {
	let fetchSpy: ReturnType<typeof vi.fn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi.fn();
		// @ts-expect-error — override
		global.fetch = fetchSpy;
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test('IA_SERVER_URL absent (undefined) → no-match, pas de fetch', async () => {
		const classify = createClassifyWord2vec(undefined);
		const result = await classify('reparer', '', intents);
		expect(result).toEqual({ intent: '', confidence: 0 });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test('IA_SERVER_URL vide → no-match, pas de fetch', async () => {
		const classify = createClassifyWord2vec('');
		const result = await classify('reparer', '', intents);
		expect(result).toEqual({ intent: '', confidence: 0 });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test('Liste intents vide → no-match, pas de fetch', async () => {
		const classify = createClassifyWord2vec('http://ia.test');
		const result = await classify('reparer', '', []);
		expect(result).toEqual({ intent: '', confidence: 0 });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test('response.ok=false (503 modèle absent) → no-match', async () => {
		fetchSpy.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
		const classify = createClassifyWord2vec('http://ia.test');
		const result = await classify('reparer', '', intents);
		expect(result).toEqual({ intent: '', confidence: 0 });
		expect(errorSpy).toHaveBeenCalled();
	});

	test('fetch throw (IA injoignable) → no-match', async () => {
		fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
		const classify = createClassifyWord2vec('http://ia.test');
		const result = await classify('reparer', '', intents);
		expect(result).toEqual({ intent: '', confidence: 0 });
		expect(errorSpy).toHaveBeenCalled();
	});

	test('response.json() throw → no-match', async () => {
		fetchSpy.mockResolvedValue({
			ok: true,
			json: async () => {
				throw new Error('bad json');
			}
		});
		const classify = createClassifyWord2vec('http://ia.test');
		const result = await classify('reparer', '', intents);
		expect(result).toEqual({ intent: '', confidence: 0 });
	});
});
