// Adaptateur SvelteKit pour le classifier word2vec (cf. docs/narrative-engine-design.md
// §6.1 / Phase 6). La logique HTTP pure vit dans `classify-core.ts` ; ce fichier ne
// fait que la lier à `$env/dynamic/private` (IA_SERVER_URL, IA_CLASSIFY_BACKEND).
//
// Server-only : importe `$env/dynamic/private`. Ne JAMAIS importer depuis le bundle
// navigateur.

import { env } from '$env/dynamic/private';
import { classifyStub } from '$lib/narrative';
import type { Classifier } from '$lib/scenario/runtime-scripted';
import { createClassifyWord2vec } from './classify-core';

export const classifyWord2vec: Classifier = (text, promptIa, intents) =>
	createClassifyWord2vec(env.IA_SERVER_URL)(text, promptIa, intents);

// Selector pour `+page.server.ts` : choisit le backend selon `IA_CLASSIFY_BACKEND`.
//   - `word2vec` : appelle `/api/classify` du serveur Go.
//   - tout le reste (`stub`, vide, inconnu) : stub TS local (Phase 5.2).
// Ajouter un backend LLM en Phase 7 = ajouter un cas ici sans toucher au site d'appel.
export function pickClassifier(): Classifier {
	const backend = (env.IA_CLASSIFY_BACKEND ?? '').toLowerCase();
	if (backend === 'word2vec') return classifyWord2vec;
	return classifyStub;
}
