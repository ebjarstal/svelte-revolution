// Stub classifieur TS pour le moteur scripted (cf. docs/narrative-engine-design.md §5.2).
// Substitut local de l'endpoint Go `/api/classify` (Phase 6). Stratégie : keyword matching
// sur les descriptions d'intent + repli sur le premier intent déclaré quand aucun candidat
// ne marque.
//
// HERMÉTIQUE : aucun import Svelte/i18n. Réutilisable côté serveur, navigateur, ou tests.

import type { ClassifyResult, IntentDecl } from './types';

export type { ClassifyResult, IntentDecl };

// Taxonomie de classifications connue (3036 utilise CONFORME / NON_CONFORME / CRITIQUE /
// NON_COOPERATIF / RIEN / CREATIF / EVEIL). Chaque label est associé à 1+ « descripteurs
// minuscules » : motifs typiquement écrits en clair dans le `prompt_ia` (« réponse
// conforme », « non coopérative », « créatif »…). Si le descripteur apparaît dans le
// prompt_ia, le label devient candidat, avec comme pool de mots-clés le voisinage du
// descripteur dans le prompt. Quand un label de cette taxonomie est résolu, on pose
// AUSSI `classification` sur le résultat — sans quoi le moteur ne peut pas évaluer
// `classification_is:` (cf. engine.ts ctx.classification).
//
// NB : l'ordre dans le tableau de descripteurs n'a pas d'importance ; on collecte
// toutes les occurrences. Les motifs avec espaces (`non conforme`) sont matchés
// après normalisation NFD + lowercase + strip diacritiques (donc « non coopérative »
// matche aussi « non cooperative »).
const KNOWN_CLASSIFICATIONS: Record<string, string[]> = {
	CONFORME: ['conforme'],
	NON_CONFORME: ['non conforme', 'non-conforme'],
	CRITIQUE: ['critique'],
	NON_COOPERATIF: ['non cooperative', 'non cooperatif', 'non-cooperative', 'non-cooperatif'],
	RIEN: ['rien', 'hors sujet'],
	CREATIF: ['creati'], // matche créatif / créative / créativité (après strip diacritiques)
	EVEIL: ['eveil']
};

// Fenêtre (en caractères) autour de chaque occurrence d'un descripteur trouvé dans
// `prompt_ia`, dont les tokens forment le pool de mots-clés du label. Heuristique :
// la phrase décrivant un label est typiquement < 200 chars dans les prompt_ia des fixtures.
const PROMPT_LABEL_WINDOW = 200;

// Stop-words FR/EN les plus fréquents — retirés des tokens player + keywords pour réduire
// le bruit (« je », « le », « pour » apparaissent dans toutes les descriptions).
const STOP_WORDS = new Set([
	'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'd', 'l',
	'et', 'ou', 'que', 'qui', 'ce', 'cette', 'ces',
	'je', 'tu', 'il', 'elle', 'on', 'nous', 'vous', 'ils', 'elles',
	'est', 'sont', 'a', 'ai', 'as', 'as', 'avez', 'avons', 'ont', 'avoir', 'etre',
	'au', 'aux', 'en', 'y', 'pas', 'ne', 'pour', 'dans', 'sur', 'avec', 'par', 'si',
	'son', 'sa', 'ses', 'ma', 'mes', 'mon', 'ta', 'tes', 'ton',
	'plus', 'moins', 'tres',
	'me', 'te', 'se',
	'the', 'a', 'an', 'and', 'or', 'is', 'are', 'was', 'were',
	'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by',
	'i', 'you', 'he', 'she', 'we', 'they', 'it'
]);

export function classifyStub(
	text: string,
	prompt_ia: string,
	intents: IntentDecl[]
): ClassifyResult {
	const playerTokens = tokenize(text);

	const intentLabels = intents.map((i) => i.label);
	const promptNormalized = normalize(prompt_ia);
	const classifLabels = labelsMentionedInPrompt(promptNormalized);
	// Préserve l'ordre : intents d'abord (premier déclaré = fallback du spec), puis classifications.
	const candidates = uniq([...intentLabels, ...classifLabels]);

	if (candidates.length === 0) {
		return { intent: '', confidence: 0 };
	}

	const intentByLabel = new Map(intents.map((i) => [i.label, i] as const));

	let bestLabel = candidates[0];
	let bestScore = 0;
	for (const label of candidates) {
		const keywords = keywordsForLabel(label, intentByLabel.get(label), promptNormalized);
		let score = 0;
		for (const token of playerTokens) {
			if (keywords.has(token)) score++;
		}
		if (score > bestScore) {
			bestScore = score;
			bestLabel = label;
		}
	}

	const result: ClassifyResult = {
		intent: bestLabel,
		confidence:
			bestScore > 0
				? Math.min(1, bestScore / Math.max(1, playerTokens.length))
				: 0.1
	};
	if (bestLabel in KNOWN_CLASSIFICATIONS) {
		result.classification = bestLabel;
	}
	return result;
}

function normalize(s: string): string {
	return s
		.toLowerCase()
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '');
}

function tokenize(s: string): string[] {
	const raw = normalize(s).split(/[^a-z0-9_]+/);
	const out: string[] = [];
	for (const t of raw) {
		if (t.length < 2) continue;
		if (STOP_WORDS.has(t)) continue;
		out.push(t);
	}
	return out;
}

// Pour chaque label de la taxonomie connue, retourne ceux dont au moins un descripteur
// apparaît dans `promptNormalized` (déjà passé par `normalize()`). L'ordre suit
// `KNOWN_CLASSIFICATIONS` (CONFORME d'abord, puis NON_CONFORME, etc.) — c'est l'ordre
// de fallback côté caller lorsqu'aucun keyword ne marque.
function labelsMentionedInPrompt(promptNormalized: string): string[] {
	const out: string[] = [];
	for (const [label, descriptors] of Object.entries(KNOWN_CLASSIFICATIONS)) {
		for (const d of descriptors) {
			if (promptNormalized.includes(d)) {
				out.push(label);
				break;
			}
		}
	}
	return out;
}

function uniq<T>(arr: T[]): T[] {
	return Array.from(new Set(arr));
}

// Récupère le pool de mots-clés associé à un label :
//   - intent structuré ⇒ tokens du `description` + tokens du `label` lui-même
//   - label de classification ⇒ tokens d'une fenêtre autour de chaque occurrence d'un
//     descripteur (« conforme », « critique », « créati »…) dans le prompt_ia normalisé
function keywordsForLabel(
	label: string,
	intent: IntentDecl | undefined,
	promptNormalized: string
): Set<string> {
	const kw = new Set<string>();
	for (const t of tokenize(label.replace(/_/g, ' '))) kw.add(t);
	if (intent) {
		for (const t of tokenize(intent.description)) kw.add(t);
		return kw;
	}
	const descriptors = KNOWN_CLASSIFICATIONS[label] ?? [];
	for (const descriptor of descriptors) {
		let idx = promptNormalized.indexOf(descriptor);
		while (idx !== -1) {
			const start = Math.max(0, idx - PROMPT_LABEL_WINDOW / 2);
			const end = Math.min(promptNormalized.length, idx + descriptor.length + PROMPT_LABEL_WINDOW / 2);
			for (const t of tokenize(promptNormalized.slice(start, end))) kw.add(t);
			idx = promptNormalized.indexOf(descriptor, idx + descriptor.length);
		}
	}
	return kw;
}
