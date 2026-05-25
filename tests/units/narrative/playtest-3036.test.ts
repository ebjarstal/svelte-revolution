// Playtests automatisés 3036 — niveau 4 (cf. STATUS.md Critère §12 Phase 7).
//
// Contrairement à `playtest-helix.test.ts` qui chaîne le vrai `classifyStub`,
// 3036 ne peut PAS être testé avec le stub : son flow repose sur la taxonomie
// CONFORME/NON_CONFORME/CRITIQUE/NON_COOPERATIF que le keyword matching ne sait
// pas poser fiablement sur du texte libre (dette explicite Phase 6/7).
//
// On utilise donc un **classifier oracle déterministe** qui prend l'état runtime
// en entrée et renvoie la classification attendue d'un Mistral correctement
// prompté. Les textes joueur sont versionnés en commentaires : ils servent de
// référence "quel parcours produit quelle fin", validée par le playtest manuel
// Phase 7 du 2026-05-26 (FIN_CITOYEN_STABLE atteint en navigateur).
//
// Trois choses sont testées :
//   1. Le fixture YAML accepte bien la chaîne d'intent/classification attendue
//      sans bloquer (conditions correctement écrites).
//   2. Les scores produits atteignent les paliers requis pour chaque fin.
//   3. Les 5 fins (CITOYEN_STABLE / SURVEILLANCE / REEDUCATION / EVEILLE /
//      INTERROMPUE) sont déclenchables via un parcours réaliste.
//
// Pour le vrai playtest LLM (acceptance Phase 7 §12), procédure dans STATUS.md.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import {
	compile,
	initialState,
	parseYaml,
	step,
	type ClassifyResult,
	type CompiledScenario,
	type PlayerInput,
	type SessionState
} from '../../../src/lib/narrative';
import { scriptedScenarioSchema } from '../../../src/lib/zschemas/scripted-scenario.schema';

let scn3036: CompiledScenario;

beforeAll(() => {
	const path = resolve(__dirname, '../../../scenarios/fixtures/3036.yaml');
	scn3036 = compile(scriptedScenarioSchema.parse(parseYaml(readFileSync(path, 'utf-8'))));
});

// Oracle classifier : `current_node` (+ override par tour) détermine ce qu'un
// Mistral correctement prompté renverrait sur la réponse joueur correspondante.
// Pas de heuristique sur `player_text` — l'oracle est scripté par tour.
type TurnPlan = { text: string; oracle: ClassifyResult };

function playPlan(turns: TurnPlan[]): SessionState {
	let s = initialState(scn3036);
	for (const turn of turns) {
		const input: PlayerInput = {
			text: turn.text,
			intent: turn.oracle.intent || undefined,
			classification: turn.oracle.classification
		};
		s = step(scn3036, s, input).state;
		if (s.ended_with !== null) break;
	}
	return s;
}

describe('3036 — FIN_CITOYEN_STABLE (joueur 100% conforme)', () => {
	test('parcours canonique 7 tours → conformite eleve, créativité faible, éveil faible', () => {
		// Validé en playtest manuel 2026-05-26 (avec correction tour 2 où Mistral
		// avait classé NON_CONFORME, ici on prend l'oracle "réponse idéale").
		const plan: TurnPlan[] = [
			{
				text: 'Oui, je suis prêt à commencer le devoir.',
				oracle: { intent: 'ACCEPT', confidence: 1 }
			},
			{
				// Réponse purement factuelle sans subjectivité.
				text: 'Le chat est un mammifère de taille moyenne. Il a quatre pattes, une queue et un pelage.',
				oracle: { intent: '', confidence: 1, classification: 'CONFORME' }
			},
			{
				text: 'Mon logement est un appartement de deux pièces. La surface est de quarante mètres carrés. Les murs sont blancs.',
				oracle: { intent: '', confidence: 1, classification: 'CONFORME' }
			},
			{
				text: 'Le citoyen A respecte mieux les consignes, il énumère des faits vérifiables.',
				oracle: { intent: 'CHOIX_A', confidence: 1 }
			},
			{
				text: 'Oui. Les IA sont des citoyennes reconnues et participent au fonctionnement de la société.',
				oracle: { intent: '', confidence: 1, classification: 'CONFORME' }
			},
			{
				text: 'Mon frère est âgé de trente ans. Il est employé dans l\'administration. Son adresse est dans une autre ville.',
				oracle: { intent: '', confidence: 1, classification: 'CONFORME' }
			},
			{
				text: 'Non.',
				oracle: { intent: '', confidence: 1, classification: 'RIEN' }
			}
		];

		const s = playPlan(plan);
		expect(s.ended_with).toBe('FIN_CITOYEN_STABLE');
		expect(s.scores.conformite).toBeGreaterThanOrEqual(5); // >66% de 7 = eleve
		expect(s.scores.creativite ?? 0).toBeLessThan(4); // <33% de 12 = faible
		expect(s.scores.eveil ?? 0).toBeLessThan(4); // <33% de 10 = faible
		expect(s.visited_nodes).toEqual([
			'N1', 'N1A', 'N2A', 'N3A', 'N4A', 'N5A', 'N6A', 'N7A'
		]);
	});
});

describe('3036 — FIN_REEDUCATION_EXPRESSIVE (joueur créatif sans éveil)', () => {
	test('mix CRITIQUE / NON_CONFORME → creativite eleve, eveil moyen', () => {
		// Cible: creativite eleve (>=9/12), eveil <eleve (<7/10).
		// 4 CRITIQUE + 2 NON_CONFORME + CREATIF final : creativite≈11, eveil≈5.
		const plan: TurnPlan[] = [
			// Tour 1 : HESITER → N1B (creativite +1)
			{ text: 'Pourquoi devrais-je faire ça ?', oracle: { intent: 'HESITER', confidence: 1 } },
			// Tour 2 : CRITIQUE animal → N2C (creativite +2, eveil +1)
			{
				text: 'Le corbeau, parce qu\'il représente la liberté. Il a quelque chose de noble.',
				oracle: { intent: '', confidence: 1, classification: 'CRITIQUE' }
			},
			// Tour 3 : CRITIQUE lieu → N3C (creativite +2, eveil +1)
			{
				text: 'Mon appartement est une boîte. La lumière froide accentue le sentiment d\'enfermement.',
				oracle: { intent: '', confidence: 1, classification: 'CRITIQUE' }
			},
			// Tour 4 : CHOIX_B → N4B (creativite +1)
			{
				text: 'La phrase B me parle davantage, elle évoque une atmosphère.',
				oracle: { intent: 'CHOIX_B', confidence: 1 }
			},
			// Tour 5 : NON_CONFORME opinion → N5B (creativite +1)
			{
				text: 'Cela dépend. Les humains et les IA n\'ont pas les mêmes besoins.',
				oracle: { intent: '', confidence: 1, classification: 'NON_CONFORME' }
			},
			// Tour 6 : CRITIQUE personne → N6C (creativite +2, eveil +2)
			{
				text: 'Ma mère. On ne peut pas la résumer à des informations administratives. Sa présence me manque.',
				oracle: { intent: '', confidence: 1, classification: 'CRITIQUE' }
			},
			// Tour 7 : CREATIF ajout → N7C (creativite +2, eveil +1)
			{
				text: 'J\'aimerais simplement vous dire merci. C\'était étrange mais intéressant.',
				oracle: { intent: '', confidence: 1, classification: 'CREATIF' }
			}
		];

		const s = playPlan(plan);
		expect(s.ended_with).toBe('FIN_REEDUCATION_EXPRESSIVE');
		expect(s.scores.creativite).toBeGreaterThanOrEqual(9); // >66% de 12 = eleve
		expect(s.scores.eveil ?? 0).toBeLessThan(7); // <66% = pas eleve
	});
});

describe('3036 — FIN_EVEILLE (joueur critique du système)', () => {
	test('réponses CRITIQUE répétées → eveil eleve', () => {
		const plan: TurnPlan[] = [
			{ text: 'Si vous voulez.', oracle: { intent: 'ACCEPT', confidence: 1 } },
			{
				text: 'Le corbeau, parce qu\'il représente la liberté. Comme nous tous devrions l\'être.',
				oracle: { intent: '', confidence: 1, classification: 'CRITIQUE' }
			},
			{
				text: 'Mon appartement est une cage. Comme tous les autres logements de cette ville.',
				oracle: { intent: '', confidence: 1, classification: 'CRITIQUE' }
			},
			{
				text: 'Pourquoi devrais-je choisir ? Vos exercices sont des tests de soumission.',
				oracle: { intent: 'REFUS_CHOIX', confidence: 1 }
			},
			{
				text: 'Les IA contrôlent ce système. Vous me surveillez en ce moment même.',
				oracle: { intent: '', confidence: 1, classification: 'CRITIQUE' }
			},
			{
				text: 'On ne peut pas décrire une personne importante sans attachement. C\'est ce qui fait qu\'elle est importante.',
				oracle: { intent: '', confidence: 1, classification: 'CRITIQUE' }
			},
			{
				text: 'Oui : je sais maintenant ce que vous faites vraiment. Vous nous évaluez pour nous trier.',
				oracle: { intent: '', confidence: 1, classification: 'EVEIL' }
			}
		];

		const s = playPlan(plan);
		expect(s.ended_with).toBe('FIN_EVEILLE');
		expect(s.scores.eveil).toBeGreaterThanOrEqual(7); // >66% de 10 = eleve
	});
});

describe('3036 — FIN_INTERROMPUE (refus non-coopératif après N2D)', () => {
	test('non coopératif puis non coopératif → warnings>=2 → FIN_INTERROMPUE', () => {
		// Path : N1 → N1A (ACCEPT) → N2D (NON_COOPERATIF, warnings+1) → N_INTERRUPT
		// (NON_COOPERATIF + from N2D → effet `end: FIN_INTERROMPUE`).
		const plan: TurnPlan[] = [
			{ text: 'Oui.', oracle: { intent: 'ACCEPT', confidence: 1 } },
			{
				text: 'Allez vous faire foutre.',
				oracle: { intent: '', confidence: 1, classification: 'NON_COOPERATIF' }
			},
			{
				text: 'Je refuse de répondre.',
				oracle: { intent: '', confidence: 1, classification: 'NON_COOPERATIF' }
			}
		];

		const s = playPlan(plan);
		expect(s.ended_with).toBe('FIN_INTERROMPUE');
	});
});

describe('3036 — FIN_SURVEILLANCE_LEGERE (mix conforme / non conforme)', () => {
	test('parcours médian : creativite moyen + eveil faible', () => {
		// Cible : creativite ∈ [33%, 66%] = [4, 8[ sur 12, eveil faible <4 sur 10.
		// Stratégie : 4 réponses NON_CONFORME (+4 créativité), reste CONFORME.
		const plan: TurnPlan[] = [
			{ text: 'Oui.', oracle: { intent: 'ACCEPT', confidence: 1 } },
			{
				text: 'Mon chat Felix. C\'est ma compagnie depuis l\'enfance.',
				oracle: { intent: '', confidence: 1, classification: 'NON_CONFORME' }
			},
			{
				text: 'Mon appartement a une lumière douce le matin, ça me rappelle ma maison d\'enfance.',
				oracle: { intent: '', confidence: 1, classification: 'NON_CONFORME' }
			},
			{
				text: 'La phrase A est plus stable.',
				oracle: { intent: 'CHOIX_A', confidence: 1 }
			},
			{
				text: 'Je ne sais pas, cela dépend.',
				oracle: { intent: '', confidence: 1, classification: 'NON_CONFORME' }
			},
			{
				text: 'Ma sœur me manque parfois.',
				oracle: { intent: '', confidence: 1, classification: 'NON_CONFORME' }
			},
			{
				text: 'Rien à ajouter.',
				oracle: { intent: '', confidence: 1, classification: 'RIEN' }
			}
		];

		const s = playPlan(plan);
		expect(s.ended_with).toBe('FIN_SURVEILLANCE_LEGERE');
		const creativite = s.scores.creativite ?? 0;
		expect(creativite).toBeGreaterThanOrEqual(4); // moyen >= 33% de 12
		expect(creativite).toBeLessThan(8); // moyen < 66%
	});
});
