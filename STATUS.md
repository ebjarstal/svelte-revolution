# STATUS — 2026-05-25

## Phase courante
Phase 2 terminée. Phase 3 démarrage.

## Dernière étape complétée
- **Phase 1** : 2 fixtures YAML encodées, parseur YAML hermétique, 15 tests PASS.
- **Phase 2** : schema BD patché, Zod schema créé, types TS étendus.
  - `db/schema.json` : +3 collections (Characters, Evidences, StateAxes), Scenario +5 champs, Node +8 champs, Session +8 champs, End +2 champs. `Node.session` rendu optionnel (scripted nodes appartiennent au scénario, pas à une session). `TriggerNodes` gardée (à supprimer plus tard).
  - `src/lib/zschemas/scripted-scenario.schema.ts` : Zod hermétique (pas d'import `$lib/i18n` ni `scenario.schema`), valide les 2 fixtures.
  - `src/types/pocketBase/TableTypes.d.ts` : interfaces Character, Evidence, StateAxis ; Scenario/Node/Session/End étendus avec champs optionnels.
  - `src/types/pocketBase/index.ts` : `MyPocketBase` étendu avec les 3 nouvelles collections.

## Prochaine étape
Phase 3 : moteur narratif pur dans `src/lib/narrative/` (DSL evaluator, condition predicates, effects, end selector, runtime step). Tests Vitest qui rejouent les parcours canoniques des 2 fixtures.

## Tests
- `pnpm check` : ✅ 0 errors (3 warnings pré-existants ignorés).
- `pnpm test:unit --run tests/units/narrative` : ✅ 19/19 PASS (15 Phase 1 + 4 Phase 2).
- `pnpm test:unit --run` (sans cible) : ❌ pré-existant `scenario.test.ts` (hors scope, non touché).

## Audit nœuds Helix Corp (PDF vs encodé)

Tous les noeuds numérotés du PDF Scenario 2-Helix Corp.pdf sont présents dans helix-corp.yaml :

| PDF | Encodé | Effet noté |
|---|---|---|
| NOEUD 1 RÉVEIL | N1 (is_start) | — |
| NOEUD 2 TERMINAL | N2 | — |
| NOEUD 2.1 ÉTAT VAISSEAU | N2.1 | unlock P1 |
| NOEUD 2.2 LOGS | N2.2 | unlock P2, P3 |
| NOEUD 2.3 RÉPARATION | N2.3 | unlock P4 |
| NOEUD 2.4 LISTE ACCÈS | N2.4 | unlock P5 |
| NOEUD 2.5 ACCÈS SUPÉRIEUR | N2.5 | unlock P10 |
| NOEUD 3 EQUIPAGE | N3 | — |
| NOEUD 3.1 QUESTION GLOBALE | N3.1 | — |
| NOEUD 3.2 OBSERVER | N3.2 | — |
| NOEUDS 4 → 4.5 (Nolan) | N4, N4.1..N4.5 | N4.2 unlock P7 |
| NOEUDS 5 → 5.5 (Elina) | N5, N5.1..N5.5 | N5.2 unlock P8 |
| NOEUDS 6 → 6.5 (Arman) | N6, N6.1..N6.5 | N6.2 unlock P9 |
| NOEUDS 7 → 7.6 (Kira) | N7, N7.1..N7.6 | N7.4 unlock P6 |
| NOEUD 8 OBSERVER VAISSEAU | N8 | — |
| NOEUDS 9-12 MONTRER PREUVE | N9, N10, N11, N12 | — |
| NOEUDS 13 → 13.5 ACCUSATION | N13, N13.1..N13.5 | tous `consumes_action: false` |
| FIN RÉUSSITE / ÉCHEC TEMPS / ÉCHEC ACCUSATION | FIN_REUSSITE (30), FIN_ECHEC_TEMPS (20), FIN_ECHEC_ACCUSATION (10) | — |
| (ajouté) | NF_HESITE fallback | — |

## Audit nœuds 3036 (PDF vs encodé)

Tous les noeuds du PDF Scenario 3036.pdf sont présents :

| PDF | Encodé |
|---|---|
| Prologue + NOEUD 1 PRÊT À COMMENCER | N1 (is_start) |
| NOEUDS 1A / 1B | N1A (intent ACCEPT), N1B (intent HESITER) |
| NOEUD 2 EXERCICE ANIMAL (prompt eval) | encodé sur prompt_ia de N1A/N1B/N2D via anchor `&animalEvaluator` |
| NOEUDS 2A/2B/2C/2D | N2A, N2B, N2C, N2D |
| NOEUD 3 EXERCICE LIEU (prompt eval) | anchor `&lieuEvaluator` sur N2A/N2B/N2C |
| NOEUDS 3A/3B/3C | N3A, N3B, N3C |
| NOEUD 4 COMPARAISON (prompt eval) | anchor `&comparaisonEvaluator` sur N3A/N3B/N3C |
| NOEUDS 4A/4B/4C | N4A, N4B, N4C |
| NOEUD 5 OPINION (prompt eval) | anchor `&opinionEvaluator` sur N4A/N4B/N4C |
| NOEUDS 5A/5B/5C | N5A, N5B, N5C |
| NOEUD 6 PERSONNE (prompt eval) | anchor `&personneEvaluator` sur N5A/N5B/N5C |
| NOEUDS 6A/6B/6C | N6A, N6B, N6C |
| NOEUD 7 DERNIÈRE QUESTION (prompt eval) | anchor `&ajoutEvaluator` sur N6A/N6B/N6C |
| NOEUDS 7A/7B/7C/7D | N7A, N7B, N7C, N7D |
| FIN 1 / 2 / 3 / 4 / 5 | FIN_CITOYEN_STABLE (10), FIN_SURVEILLANCE_LEGERE (20), FIN_REEDUCATION_EXPRESSIVE (30), FIN_EVEILLE (40), FIN_INTERROMPUE (50) |
| (ajouté) | N_INTERRUPT (déclenche FIN_INTERROMPUE par effet `end:` sur 2e refus), NF_REFORMULE fallback |

## Questions bloquantes
*(aucune — voir Ambigus ci-dessous, choix conservateurs faits)*

## Ambigus rencontrés (résolus de façon conservatrice)
- **3036 paliers faible/moyen/élevé** : le PDF dit « définir plus tard ». Adopté les paliers du design doc §4.2 : `<33% / 33-66% / >66%` sur les `score_caps` `{conformite: 7, creativite: 12, eveil: 10}` calculés depuis les effets observés des chemins extrêmes du PDF. Commentaire `AMBIGU` dans `3036.yaml`.
- **3036 mécanisme d'interruption** : PDF dit « Si deuxième refus : aller vers N END_ADMINISTRATIF ». Encodé via un noeud `N_INTERRUPT` à condition stricte (`from: N2D` + `classification_is: NON_COOPERATIF`) avec effet `end: FIN_INTERROMPUE`. Permet de garder `end_eval_after: null` (chaque tour) sans risquer de déclencher d'autres fins en cours de jeu — les fins scoring sont gardées par `any: [from N7A, from N7B, from N7C, from N7D]`. Commentaire `AMBIGU` dans `3036.yaml`.
- **Helix N5.2** : le PDF ne le numérote pas explicitement (« Condition : joueur mentionne Irisite… » sans titre N5.2). Numéroté `N5.2` par cohérence avec la branche Elina (N5, N5.1, [N5.2], N5.3, N5.4, N5.5) et la séquence des autres branches.
- **Helix accusation Kira sans preuves N13.4 vs N7.6** : deux noeuds avec sémantique proche dans le PDF. Disambiguation : `N7.6` = intent SUSPECTER + has_count_among lte 1 (informel, dans la branche Kira). `N13.5/N13.4` = from N13 + has_count_among gte 3 / lte 2 (formel, après déclenchement accusation). Choix de seuils tirés directement du PDF (2 et 3 respectivement).
- **Helix N7.4 (Directive Helix)** : le PDF dit « après avoir P10 ou P5 ». Encodé `any: [has P5_ACCES_EQUIPAGE, has P10_KIRA_A_ACCES_SUPERIEUR]`.

## Idées à proposer (hors scope nuit)
- (Phase 4+) `Node.priority` explicite pour casser les ambiguïtés de specificité (cf. design doc §13.6).
- (Phase 4+) Encoder l'idée d'« exercice courant » comme champ de Session pour 3036, éviter le pattern un peu lourd de `any: [from N7A, from N7B, ...]` dans les conditions d'ends.
- (Phase 5+) Une suite de tests « parcours du joueur » plus large que ce que la Phase 3 couvrira (couverture chemins).

## Journal des commits de la nuit
*(rempli après chaque commit)*
