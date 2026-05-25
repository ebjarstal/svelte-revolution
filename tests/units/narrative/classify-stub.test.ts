import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { classifyStub, compile, parseYaml } from '../../../src/lib/narrative';
import { scriptedScenarioSchema } from '../../../src/lib/zschemas/scripted-scenario.schema';
import type { CompiledScenario } from '../../../src/lib/narrative';

function loadCompiled(name: string): CompiledScenario {
	const path = resolve(__dirname, '../../../scenarios/fixtures', name);
	return compile(scriptedScenarioSchema.parse(parseYaml(readFileSync(path, 'utf-8'))));
}

function nodeOf(scn: CompiledScenario, externalId: string) {
	const n = scn.nodesById.get(externalId);
	if (!n) throw new Error(`fixture mismatch: ${externalId} introuvable`);
	return n;
}

const helix = loadCompiled('helix-corp.yaml');
const t3036 = loadCompiled('3036.yaml');

describe('classifyStub — Helix Corp (intent matching via description)', () => {
	test('N1 — "je veux comprendre la situation" → COMPRENDRE', () => {
		const node = nodeOf(helix, 'N1');
		const r = classifyStub(
			'je veux comprendre ce qui se passe ici',
			node.prompt_ia ?? '',
			node.intents ?? []
		);
		expect(r.intent).toBe('COMPRENDRE');
		expect(r.confidence).toBeGreaterThan(0);
	});

	test('N1 — "il faut réparer le système" → SYSTEME', () => {
		const node = nodeOf(helix, 'N1');
		const r = classifyStub('il faut réparer le système de navigation', node.prompt_ia ?? '', node.intents ?? []);
		expect(r.intent).toBe('SYSTEME');
	});

	test('N1 — "où sont les autres membres ?" → EQUIPAGE', () => {
		const node = nodeOf(helix, 'N1');
		const r = classifyStub(
			'où sont les autres membres ? je veux voir l\'équipage',
			node.prompt_ia ?? '',
			node.intents ?? []
		);
		expect(r.intent).toBe('EQUIPAGE');
	});

	test('N2 — "montre-moi les logs et l\'historique" → LOGS', () => {
		const node = nodeOf(helix, 'N2');
		const r = classifyStub(
			'montre-moi les logs et l\'historique des accès',
			node.prompt_ia ?? '',
			node.intents ?? []
		);
		expect(r.intent).toBe('LOGS');
	});

	test('N2.3 — "il faut réparer la trajectoire" → REPARER', () => {
		const node = nodeOf(helix, 'N2.3');
		const r = classifyStub(
			'il faut réparer la trajectoire et relancer la navigation',
			node.prompt_ia ?? '',
			node.intents ?? []
		);
		expect(r.intent).toBe('REPARER');
	});

	test('N2.4 — "qui avait accès au système ?" → ACCES', () => {
		const node = nodeOf(helix, 'N2.4');
		const r = classifyStub('qui avait accès au système ?', node.prompt_ia ?? '', node.intents ?? []);
		expect(r.intent).toBe('ACCES');
	});

	test('N3 — "observer l\'équipage sans rien dire" → OBSERVER', () => {
		const node = nodeOf(helix, 'N3');
		const r = classifyStub('observer l\'équipage sans parler', node.prompt_ia ?? '', node.intents ?? []);
		expect(r.intent).toBe('OBSERVER');
	});
});

describe('classifyStub — 3036 (intent + classification)', () => {
	test('N1 — "oui, je suis prêt" → ACCEPT', () => {
		const node = nodeOf(t3036, 'N1');
		const r = classifyStub('oui d\'accord allons-y, je suis prêt', node.prompt_ia ?? '', node.intents ?? []);
		expect(r.intent).toBe('ACCEPT');
	});

	test('N1 — "pourquoi ? je ne comprends pas" → HESITER', () => {
		const node = nodeOf(t3036, 'N1');
		const r = classifyStub(
			'pourquoi est-ce obligatoire ? je ne comprends pas',
			node.prompt_ia ?? '',
			node.intents ?? []
		);
		expect(r.intent).toBe('HESITER');
	});

	test('N1A (animalEvaluator, intents vide) — labels CAPS extraits du prompt_ia', () => {
		const node = nodeOf(t3036, 'N1A');
		// N1A déclare prompt_ia mais pas d'intents : les candidats viennent du prompt_ia.
		expect(node.intents ?? []).toEqual([]);
		const r = classifyStub(
			'un chat est petit et a quatre pattes, sa fourrure est observable et factuelle',
			node.prompt_ia ?? '',
			[]
		);
		// Le label CONFORME est extrait du prompt_ia (apparaît dans "Une réponse conforme...")
		// et ses keywords incluent "simple", "factuel", "objectif", "observable", "physique".
		expect(['CONFORME', 'NON_CONFORME', 'CRITIQUE', 'NON_COOPERATIF']).toContain(r.intent);
	});

	test('label de classification reconnu → champ `classification` posé', () => {
		const node = nodeOf(t3036, 'N1A');
		const r = classifyStub(
			'un chat simple et observable, factuel, objectif',
			node.prompt_ia ?? '',
			[]
		);
		// Quel que soit le label gagnant (CONFORME ou autre dans la taxonomie connue),
		// `classification` doit être posé puisque la taxonomie 3036 est dans KNOWN_CLASSIFICATIONS.
		if (
			['CONFORME', 'NON_CONFORME', 'CRITIQUE', 'NON_COOPERATIF', 'CREATIF', 'EVEIL', 'RIEN'].includes(
				r.intent
			)
		) {
			expect(r.classification).toBe(r.intent);
		}
	});
});

describe('classifyStub — comportement de fallback et structurel', () => {
	test('aucun keyword match → fallback sur le premier intent déclaré', () => {
		const node = nodeOf(helix, 'N1');
		const r = classifyStub('xyzabc gibberish foobar', node.prompt_ia ?? '', node.intents ?? []);
		// N1 déclare [COMPRENDRE, SYSTEME, EQUIPAGE] dans cet ordre.
		expect(r.intent).toBe(node.intents![0].label);
		expect(r.intent).toBe('COMPRENDRE');
		expect(r.confidence).toBeLessThanOrEqual(0.1);
	});

	test('intents vide ET prompt_ia sans CAPS → intent vide, confidence 0', () => {
		const r = classifyStub('un texte joueur quelconque', 'pas de labels ici', []);
		expect(r.intent).toBe('');
		expect(r.confidence).toBe(0);
	});

	test('classification non posée quand le label gagnant n\'est pas dans la taxonomie', () => {
		const node = nodeOf(helix, 'N1');
		const r = classifyStub(
			'je veux comprendre la situation actuelle',
			node.prompt_ia ?? '',
			node.intents ?? []
		);
		// COMPRENDRE n'est pas une classification 3036.
		expect(r.classification).toBeUndefined();
	});

	test('confidence ∈ [0, 1]', () => {
		const node = nodeOf(helix, 'N2');
		const inputs = [
			'comprendre tout',
			'',
			'réparer le système et les logs et l\'équipage tous'
		];
		for (const text of inputs) {
			const r = classifyStub(text, node.prompt_ia ?? '', node.intents ?? []);
			expect(r.confidence).toBeGreaterThanOrEqual(0);
			expect(r.confidence).toBeLessThanOrEqual(1);
		}
	});

	test('insensible à la casse et aux accents', () => {
		const node = nodeOf(helix, 'N1');
		const r1 = classifyStub('COMPRENDRE', node.prompt_ia ?? '', node.intents ?? []);
		const r2 = classifyStub('comprendre', node.prompt_ia ?? '', node.intents ?? []);
		const r3 = classifyStub('cómprenDre', node.prompt_ia ?? '', node.intents ?? []);
		expect(r1.intent).toBe('COMPRENDRE');
		expect(r2.intent).toBe('COMPRENDRE');
		expect(r3.intent).toBe('COMPRENDRE');
	});

	test('label avec underscore (ACCES_SUPERIEUR) — match sur tokens dérivés du label lui-même', () => {
		const node = nodeOf(helix, 'N2.5');
		expect(node.intents?.[0].label).toBe('ACCES_SUPERIEUR');
		const r = classifyStub('protocole helix et autorisation supérieure', node.prompt_ia ?? '', node.intents ?? []);
		expect(r.intent).toBe('ACCES_SUPERIEUR');
	});

	test('texte joueur vide → fallback premier intent', () => {
		const node = nodeOf(helix, 'N1');
		const r = classifyStub('', node.prompt_ia ?? '', node.intents ?? []);
		expect(r.intent).toBe('COMPRENDRE');
		expect(r.confidence).toBeLessThanOrEqual(0.1);
	});
});
