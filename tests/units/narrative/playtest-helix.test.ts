// Playtests automatisés Helix Corp — niveau 2 (cf. acceptance Phase 5 + critère §12).
// Différence avec `engine-helix.test.ts` : ici on **chaîne le pipeline complet** que voit
// le joueur — text → `classifyStub` → `detectTarget` → `step` — plutôt que de passer
// `intent`/`target` en bypass. Ces tests transforment le script de réponses joueur en
// régression CI : si une modif du fixture, du stub, du moteur ou de la détection de
// target casse un parcours canonique, ils rougissent.
//
// Pourquoi pas le même fichier que `engine-helix.test.ts` ? L'autre teste l'engine en
// isolation (entrées contrôlées) ; celui-ci teste la **stack joueur** (sortie classifier
// non contrôlée). Garder les deux fait survivre les deux types de régression.
//
// Pas de playtest équivalent pour 3036 : son flow repose sur `classification_is:`
// (CONFORME / NON_CONFORME / CRITIQUE / NON_COOPERATIF) que le `stub` ne peut pas poser
// fiablement sur du texte libre (le pool keywords vient des descripteurs du `prompt_ia`,
// pas du texte joueur). C'est la dette explicite Phase 6/7 résolue côté `llm` — voir
// `engine-3036.test.ts` pour les parcours en bypass, et l'acceptance gate manuelle
// STATUS.md « Critère §12 Phase 7 » pour la validation playtest LLM en local.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import {
	classifyStub,
	compile,
	initialState,
	parseYaml,
	step,
	type CompiledScenario,
	type IntentDecl,
	type SessionState,
	type StepResult
} from '../../../src/lib/narrative';
import { scriptedScenarioSchema } from '../../../src/lib/zschemas/scripted-scenario.schema';
import { collectAllIntents, detectTarget } from '../../../src/lib/scenario/runtime-scripted';

let helix: CompiledScenario;

beforeAll(() => {
	const path = resolve(__dirname, '../../../scenarios/fixtures/helix-corp.yaml');
	helix = compile(scriptedScenarioSchema.parse(parseYaml(readFileSync(path, 'utf-8'))));
});

// Mime ce que `progressScripted()` fait à chaque tour : récup `intents` + `prompt_ia` du
// noeud courant, classifie le texte joueur via `classifyStub`, déduit `target` par les
// noms PNJ. Pas de PocketBase ici — on opère sur l'état runtime brut.
function playTurn(state: SessionState, playerText: string): StepResult {
	const currentNode =
		state.current_node !== null ? helix.nodesById.get(state.current_node) ?? null : null;
	// Cf. fix runtime-scripted : union des intents de tout le scénario (design §7.2.4).
	const intents: IntentDecl[] = collectAllIntents(helix);
	const promptIa = currentNode?.prompt_ia ?? '';
	const cls = classifyStub(playerText, promptIa, intents);
	return step(helix, state, {
		text: playerText,
		intent: cls.intent || undefined,
		classification: cls.classification,
		target: detectTarget(playerText, helix.characters)
	});
}

describe('Helix Corp — playtest text→stub→step jusqu\'à FIN_REUSSITE', () => {
	test('parcours canonique 9 tours : preuves N2.2/N2.4/N2.5/N7.4 + accusation Kira', () => {
		let s = initialState(helix);
		expect(s.current_node).toBe('N1');
		expect(s.actions_left).toBe(18);

		// Tour 1 — N1 → N2 (intent SYSTEME via mots 'terminal' + 'navigation')
		s = playTurn(s, 'je consulte le terminal et la navigation').state;
		expect(s.current_node, 'tour 1').toBe('N2');

		// Tour 2 — N2 → N2.2 (intent LOGS, unlock P2_ACCES_0307 + P3_LOGS_EFFACES)
		s = playTurn(s, "je veux voir les logs et l'historique des traces").state;
		expect(s.current_node, 'tour 2').toBe('N2.2');
		expect(s.evidences).toEqual(
			expect.arrayContaining(['P2_ACCES_0307', 'P3_LOGS_EFFACES'])
		);

		// Tour 3 — N2.2 → N2.4 (intent ACCES via 'accès' + 'système', unlock P5)
		s = playTurn(s, 'qui avait accès au système ?').state;
		expect(s.current_node, 'tour 3').toBe('N2.4');
		expect(s.evidences).toContain('P5_ACCES_EQUIPAGE');

		// Tour 4 — N2.4 → N2.5 (intent ACCES_SUPERIEUR, unlock P10)
		s = playTurn(s, "qui possède l'accès supérieur, l'autorisation prioritaire ?").state;
		expect(s.current_node, 'tour 4').toBe('N2.5');
		expect(s.evidences).toContain('P10_KIRA_A_ACCES_SUPERIEUR');

		// Tour 5 — N2.5 → N3 (intent EQUIPAGE)
		s = playTurn(s, "je sors de ma cabine pour parler à l'équipage").state;
		expect(s.current_node, 'tour 5').toBe('N3');

		// Tour 6 — N3 → N7 (target=kira, detectTarget pose la cible)
		s = playTurn(s, 'je vais parler à Kira').state;
		expect(s.current_node, 'tour 6').toBe('N7');

		// Tour 7 — N7 → N7.4 (intent DIRECTIVE_HELIX, unlock P6)
		s = playTurn(s, 'Kira, quels sont les ordres Helix, la directive de mission ?').state;
		expect(s.current_node, 'tour 7').toBe('N7.4');
		expect(s.evidences).toContain('P6_DIRECTIVE_HELIX');

		// Tour 8 — N7.4 → N13 (intent ACCUSER_FINAL, gratuit consumes_action:false)
		// IMPORTANT : ne pas écrire « Kira » dans ce tour, sinon `detectTarget` pose
		// `target=kira` et N7.5 (target kira + has_count_among gte 3) gagne par
		// spécificité (2 prédicats > N13 qui n'en a que 1). C'est un cul-de-sac connu
		// du design §7.2.8 : tant qu'on reste dans un contexte ciblé Kira avec assez
		// de preuves, l'accusation formelle N13 reste inatteignable.
		const actionsAtT7 = s.actions_left;
		s = playTurn(s, 'je formule mon accusation finale').state;
		expect(s.current_node, 'tour 8').toBe('N13');
		expect(s.actions_left, 'N13 ne consomme pas d\'action').toBe(actionsAtT7);

		// Tour 9 — N13 → N13.5 (target=kira + has_all P6+P10 + has_any P2/P3/P4)
		// puis évaluation des fins → FIN_REUSSITE matche `visited: [N13.5]` (priority 30)
		s = playTurn(s, 'Kira, voici les preuves : accès à 03:07, logs effacés, directive Helix').state;
		expect(s.current_node, 'tour 9').toBe('N13.5');
		expect(s.ended_with).toBe('FIN_REUSSITE');
		// 7 noeuds consumes_action=true visités après N1 (N2, N2.2, N2.4, N2.5, N3, N7,
		// N7.4) = 7 actions consommées. N1 est le start (pas consommé par step). N13
		// et N13.5 sont gratuits. → 18 - 7 = 11 restantes.
		expect(s.actions_left).toBe(11);
	});
});

describe('Helix Corp — playtest fin alternative FIN_ECHEC_ACCUSATION', () => {
	test('accuser Nolan sans preuves suffisantes déclenche FIN_ECHEC_ACCUSATION', () => {
		let s = initialState(helix);

		// Tour 1 — N1 → N3 (intent EQUIPAGE, court-circuite N2 pour minimiser les preuves)
		s = playTurn(s, "je sors pour parler à l'équipage").state;
		expect(s.current_node, 'tour 1').toBe('N3');

		// Tour 2 — N3 → N4 (target=nolan, sans intent obligatoire car N4 n'a pas intent_in)
		s = playTurn(s, 'je vais parler à Nolan').state;
		expect(s.current_node, 'tour 2').toBe('N4');

		// Tour 3 — N4 → N13 (intent ACCUSER_FINAL, gratuit).
		// Mêmes précautions qu'au tour 8 du parcours FIN_REUSSITE : ne pas mentionner
		// Nolan ici, sinon N4.5 (target nolan + intent_in SUSPECTER, plus spécifique
		// que N13) gagne et on reste dans la branche Nolan.
		s = playTurn(s, 'je formule mon accusation finale').state;
		expect(s.current_node, 'tour 3').toBe('N13');

		// Tour 4 — N13 → N13.1. Délicat à scripter : il faut target=nolan SANS poser
		// intent=SUSPECTER (sinon N4.5 « Nolan accusé », plus spécifique au sens
		// §7.2.8, gagne par ordre d'insertion YAML). Le mot « accuse » dans le pool
		// SUSPECTER suffit à le rendre dominant si présent. On désigne donc Nolan
		// avec un texte neutre dont le stub retombe sur l'intent NOLAN (label déclaré
		// sur N3 pour rediriger, sans usage de la condition courante) — N13.1 reste
		// alors seul candidat compatible (last [N13] + target nolan).
		s = playTurn(s, "C'est Nolan le coupable").state;
		expect(s.current_node, 'tour 4').toBe('N13.1');
		expect(s.ended_with).toBe('FIN_ECHEC_ACCUSATION');
	});
});
