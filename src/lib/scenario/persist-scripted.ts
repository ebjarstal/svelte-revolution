// Persistance transactionnelle d'un CompiledScenario en PocketBase via batch
// API (SDK 0.26+). Tout réussit ou rien n'est écrit : si une seule opération
// du batch échoue, PocketBase rollback la transaction côté serveur et lève une
// ClientResponseError.
//
// Stratégie : tous les IDs (Scenario, Characters, Evidences, StateAxes, Nodes,
// Ends) sont pré-générés côté serveur. Cela permet d'écrire les FK
// (scenario, characters[], evidences[], state_axes[]) dans le même batch sans
// round-trip intermédiaire.
//
// Mapping des champs PB obligatoires non présents dans le YAML scripted (cf.
// docs/narrative-engine-design.md §3.4 — cohabitation avec le moteur free) :
//   - Scenario.firstNodeTitle/Text/Author ← depuis le startNode du compiled
//   - Scenario.lang ← prefix ISO du `lang` YAML (`fr-FR` → `fr`)
//   - Node.title ← node.titre (fallback : external_id)
//   - Node.text ← node.texte (fallback : '')
//   - Node.author ← uploaderId (PB id du superAdmin)
//   - Node.type ← is_start ? 'startNode' : 'contribution'

import type { ClientResponseError } from 'pocketbase';
import type { CompiledScenario, EndFixture, NodeFixture } from '$lib/narrative';
import type { MyPocketBase } from '$types/pocketBase';
import { pbId } from './pb-id';

export class BatchPersistError extends Error {
	constructor(message: string, public readonly cause?: unknown) {
		super(message);
		this.name = 'BatchPersistError';
	}
}

export interface PersistResult {
	scenarioId: string;
}

export async function persistCompiledScenario(
	pb: MyPocketBase,
	compiled: CompiledScenario,
	uploaderId: string
): Promise<PersistResult> {
	const scenarioId = pbId();
	const characterIds = new Map<string, string>();
	const evidenceIds = new Map<string, string>();
	const stateAxisIds = new Map<string, string>();
	const nodeIds = new Map<string, string>();
	const endIds = new Map<string, string>();

	for (const c of compiled.characters) characterIds.set(c.external_id, pbId());
	for (const e of compiled.evidences) evidenceIds.set(e.external_id, pbId());
	for (const a of compiled.state_axes) stateAxisIds.set(a.external_id, pbId());
	for (const n of compiled.nodes) nodeIds.set(n.external_id, pbId());
	for (const e of compiled.ends) endIds.set(e.external_id, pbId());

	const start = compiled.startNode;
	// Scenario est créé d'abord SANS les relations N→N : PocketBase valide
	// les références à l'insertion et les Characters/Evidences/StateAxes ne
	// sont pas encore créés. On les câble via un Scenario.update plus loin
	// dans le batch (cf. https://github.com/pocketbase/pocketbase/issues
	// — relation validation queries the live DB even in batch transactions).
	const scenarioPayload = {
		id: scenarioId,
		title: compiled.title,
		prologue: compiled.prologue,
		lang: mapLang(compiled),
		ai: true,
		engine: 'scripted' as const,
		rules: compiled.rules,
		firstNodeTitle: start?.titre ?? compiled.title,
		firstNodeText: start?.texte ?? compiled.prologue,
		firstNodeAuthor: uploaderId
	};

	const batch = pb.createBatch();
	batch.collection('Scenario').create(scenarioPayload);

	for (const c of compiled.characters) {
		batch.collection('Characters').create({
			id: characterIds.get(c.external_id),
			scenario: scenarioId,
			external_id: c.external_id,
			name: c.name,
			role: c.role ?? '',
			bio: c.bio ?? ''
		});
	}

	for (const e of compiled.evidences) {
		batch.collection('Evidences').create({
			id: evidenceIds.get(e.external_id),
			scenario: scenarioId,
			external_id: e.external_id,
			label: e.label,
			description: e.description ?? ''
		});
	}

	for (const a of compiled.state_axes) {
		batch.collection('StateAxes').create({
			id: stateAxisIds.get(a.external_id),
			scenario: scenarioId,
			external_id: a.external_id,
			label: a.label,
			description: a.description ?? ''
		});
	}

	// Câble les relations N→N une fois que Characters/Evidences/StateAxes
	// existent dans la transaction. Skip si tout est vide (rien à câbler).
	const hasRelations =
		characterIds.size > 0 || evidenceIds.size > 0 || stateAxisIds.size > 0;
	if (hasRelations) {
		batch.collection('Scenario').update(scenarioId, {
			characters: [...characterIds.values()],
			evidences: [...evidenceIds.values()],
			state_axes: [...stateAxisIds.values()]
		});
	}

	for (const n of compiled.nodes) {
		batch.collection('Node').create(buildNodePayload(n, nodeIds.get(n.external_id)!, scenarioId, uploaderId));
	}

	for (const e of compiled.ends) {
		batch.collection('End').create(buildEndPayload(e, endIds.get(e.external_id)!, scenarioId));
	}

	try {
		await batch.send();
	} catch (err) {
		const detail = describeBatchError(err);
		throw new BatchPersistError(`persistance du scénario "${compiled.external_id}" échouée : ${detail}`, err);
	}

	return { scenarioId };
}

function buildNodePayload(node: NodeFixture, id: string, scenarioId: string, uploaderId: string) {
	return {
		id,
		scenario: scenarioId,
		external_id: node.external_id,
		title: node.titre ?? node.external_id,
		text: node.texte ?? '',
		author: uploaderId,
		type: node.is_start ? 'startNode' : 'contribution',
		is_start: node.is_start ?? false,
		consumes_action: node.consumes_action ?? false,
		prompt_ia: node.prompt_ia ?? '',
		intents: node.intents ?? null,
		condition: node.condition ?? null,
		effects: node.effects ?? null
	};
}

function buildEndPayload(end: EndFixture, id: string, scenarioId: string) {
	return {
		id,
		scenario: scenarioId,
		external_id: end.external_id,
		title: end.title,
		text: end.text,
		priority: end.priority,
		condition: end.condition ?? null
	};
}

// PB `lang` est un enum strict `en|fr|jp`. Le YAML scripted utilise des locales
// complètes (ex `fr-FR`, `en-US`, `ja-JP`). On extrait le prefix ISO ; toute
// valeur hors enum tombe sur 'fr' (locale par défaut du projet, cf. CLAUDE.md).
function mapLang(compiled: CompiledScenario): 'en' | 'fr' | 'jp' {
	const prefix = compiled.lang.toLowerCase().split('-')[0];
	if (prefix === 'en') return 'en';
	if (prefix === 'ja' || prefix === 'jp') return 'jp';
	return 'fr';
}

function describeBatchError(err: unknown): string {
	if (typeof err === 'object' && err !== null && 'status' in err) {
		const e = err as ClientResponseError;
		const head = `${e.status ?? '?'} ${e.message ?? ''}`.trim();
		const data = (e as unknown as { data?: unknown }).data;
		const detail = extractBatchDetail(data);
		return detail ? `${head} — ${detail}` : head;
	}
	return err instanceof Error ? err.message : String(err);
}

// PB renvoie sur erreur batch un body de la forme :
//   { code, message, data: { requests: { '<index>': { code, message, data: { '<field>': { code, message } } } } } }
// On essaie d'extraire l'index, le champ et le message pour aider le diagnostic.
function extractBatchDetail(data: unknown): string | null {
	if (typeof data !== 'object' || data === null) return null;
	const root = data as Record<string, unknown>;
	const requests = root.requests;
	if (typeof requests !== 'object' || requests === null) {
		if (typeof root.message === 'string') return root.message;
		return null;
	}
	const entries = Object.entries(requests as Record<string, unknown>);
	if (entries.length === 0) return null;
	const [index, req] = entries[0]!;
	if (typeof req !== 'object' || req === null) return `requête #${index}`;
	const reqObj = req as Record<string, unknown>;
	const reqMessage = typeof reqObj.message === 'string' ? reqObj.message : 'erreur';
	const fields = reqObj.data;
	if (typeof fields === 'object' && fields !== null) {
		const fieldEntries = Object.entries(fields as Record<string, unknown>);
		const summary = fieldEntries
			.map(([field, info]) => {
				if (typeof info === 'object' && info !== null && 'message' in info) {
					return `${field}: ${(info as { message: unknown }).message}`;
				}
				return field;
			})
			.join(', ');
		if (summary) return `requête #${index} (${reqMessage}) → ${summary}`;
	}
	return `requête #${index} (${reqMessage})`;
}
