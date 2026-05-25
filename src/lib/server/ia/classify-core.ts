// Cœur hermétique du client `/api/classify` — séparé de `classify.ts` pour pouvoir
// être testé sous Vitest sans déclencher la résolution de `$env/dynamic/private`
// (les virtual modules SvelteKit ne sont pas résolus par Vitest, cf. note dans
// `tests/units/narrative/engine-dispatch.test.ts`).

import type { ClassifyResult, IntentDecl } from '$lib/narrative';
import type { Classifier } from '$lib/scenario/runtime-scripted';

interface ClassifyRequestBody {
	session: string;
	node_prompt: string;
	intents: IntentDecl[];
	player_text: string;
	session_state: Record<string, unknown>;
}

interface ClassifyResponseBody {
	intent: string;
	confidence: number;
	classification?: string;
	rationale?: string;
	alternatives?: Array<{ label: string; confidence: number }>;
}

// Fabrique un classifier qui pointe vers `iaServerUrl`. Si l'URL est falsy (env non
// défini), retourne un classifier qui no-op et logge — le moteur retombera en
// fallback no-match côté `step()`.
//
// Le payload Go peut contenir `classification` (taxonomie 3036 :
// CONFORME/NON_CONFORME/CRITIQUE/NON_COOPERATIF/CREATIF/EVEIL/RIEN). Le backend
// `word2vec` ne pose jamais ce champ ; le backend `llm` le pose quand le prompt
// l'invoque (cf. design doc §12 Phase 7). On le propage à `ClassifyResult` quand
// présent — sans quoi le moteur ne peut pas évaluer `classification_is:` sur 3036.
//
// Le nom de la fonction est resté `createClassifyWord2vec` pour rétrocompat
// d'import : l'endpoint Go est le même quel que soit le backend (le switch est
// interne au serveur Go, transparent pour ce client).
export function createClassifyWord2vec(iaServerUrl: string | undefined): Classifier {
	return async (playerText: string, promptIa: string, intents: IntentDecl[]): Promise<ClassifyResult> => {
		if (!iaServerUrl) {
			console.error('classifyWord2vec: IA_SERVER_URL not set, falling back to no-match');
			return { intent: '', confidence: 0 };
		}
		if (intents.length === 0) {
			return { intent: '', confidence: 0 };
		}

		const body: ClassifyRequestBody = {
			session: '',
			node_prompt: promptIa,
			intents,
			player_text: playerText,
			session_state: {}
		};

		try {
			const response = await fetch(`${iaServerUrl}/api/classify`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!response.ok) {
				console.error(`classifyWord2vec: HTTP ${response.status} from /api/classify`);
				return { intent: '', confidence: 0 };
			}
			const data = (await response.json()) as ClassifyResponseBody;
			const result: ClassifyResult = {
				intent: data.intent ?? '',
				confidence: typeof data.confidence === 'number' ? data.confidence : 0
			};
			if (typeof data.classification === 'string' && data.classification.length > 0) {
				result.classification = data.classification;
			}
			return result;
		} catch (e) {
			const err = e as Error;
			console.error('classifyWord2vec: fetch failed:', err.message);
			return { intent: '', confidence: 0 };
		}
	};
}
