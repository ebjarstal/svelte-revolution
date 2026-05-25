# Phase 0 — Conception du moteur narratif scripté

## 1. Contexte

L'app actuelle (cf. `CLAUDE.md`, `db/schema.json`, `ia_server/`) modélise un seul type de
session : un groupe contribue **librement en texte** sur un arbre, l'IA Go modère mot à mot
(`/api/checkMsg` ⇒ word2vec similarity + censure) et avance un compteur de `Step` linéaire
hardcodé en `ia_server/resources/scenario.json`. Une fin est choisie *par l'admin* via la form
action `endSession` (`src/routes/sessions/[slug=number]/+page.server.ts:163-202`), parmi
plusieurs `End` records.

Les deux PDFs (`scenarios/Scenario 2-Helix Corp.pdf`, `scenarios/Scenario 3036.pdf`)
décrivent un genre différent — **narration solo scriptée** où :

- l'arbre de noeuds est **pré-écrit** dans un fichier d'auteur, pas créé pendant la session ;
- chaque noeud porte sa **condition de déclenchement** (combinant position dans l'arbre,
  classification d'intention IA, état de session, possession de preuves) et ses **effets**
  (déblocage de preuve, delta de score, décrément d'actions) ;
- l'IA Go n'est plus modérateur, elle est **classifieur d'intention** parametré par un
  prompt IA propre à chaque noeud ;
- la fin est **sélectionnée automatiquement** d'après l'état de session, parmi 3 fins
  (Helix : réussite / échec accusation / échec temps) ou 5 (3036 : citoyen stable /
  surveillance / rééducation / éveillé / interrompue).

Objectif de ce doc : spécifier le moteur scripté en suffisamment de détail pour que la
Phase 1 (encoder les 2 PDFs en fixtures YAML) puisse démarrer sans nouvelle décision
d'architecture.

## 2. Écart vérifié (hypothèse vs code lu)

| Brique nécessaire | État actuel | Verdict |
|---|---|---|
| Noeuds pré-écrits attachés au scénario | `Scenario.firstNode*` seulement ; `Node` créé à la volée pendant la session (`schema.json:604-764`) | **Manquant** |
| `condition_declenchement` par noeud | Aucun champ. La sélection se fait par `IsActionPerformed()` côté Go, pas par condition déclarative (`ia_server/pkg/censorship/censorship.go:194-237`) | **Manquant** |
| `effets` par noeud | Aucun. Le runtime Go avance juste `Step` (`ia_server/webservice/isCensored.go`) | **Manquant** |
| État persistant de session (preuves, scores, actions) | Aucun champ JSON sur `Session`. L'état RAM est dans le Go (`Sessions map` in `server.go:20`), non synchro BD | **Manquant** |
| Classification d'intention paramétrée par noeud | `/api/checkMsg` ne classifie pas, il censure + détecte action via similarité word2vec | **Manquant** (à ajouter via `/api/classify`) |
| Multi-fins | OUI déjà (`End` collection, `schema.json:412-498`), mais déclenchement actuel manuel | **Présent, à étendre avec condition** |
| Compteur d'actions | Aucun | **Manquant** |
| Sélection auto de fin | Non — `endSession` est une form action admin | **Manquant** |
| Mention PNJ comme entité | Non — `Side` est une faction (QG/Terrain), pas un PNJ (`ia_server/pkg/censorship/session.go:29` hardcode "qg"/"terrain") | **À introduire** |
| Champ libre récupérable | `TriggerNodes` collection inutilisée avec un champ JSON `nodes` (`schema.json:1161-1230`) | **À garder ou supprimer** |

Donc l'hypothèse de départ est essentiellement confirmée : on n'a aucune des briques
sauf la multi-fin (mais sa sélection est manuelle).

## 3. Modèle de données

### 3.1 Stratégie

- **Cohabitation via flag `Scenario.engine: 'free' | 'scripted'`** (décision utilisateur).
- Les collections existantes (`Scenario`, `Session`, `Node`, `End`, `Side`, `Event`,
  `Users`) restent. On ajoute des champs additifs et trois nouvelles collections
  (`Characters`, `Evidences`, `StateAxes`).
- Le runtime branche au load : moteur free intouché, moteur scripted entièrement
  nouveau.

### 3.2 Modifications sur collections existantes

#### `Scenario` — ajouts

```json
{
  "engine":         "select(free|scripted), required, default=free",
  "rules":          "json, optional",
  "characters":     "n→n vers Characters, optional (scripted only)",
  "evidences":     "n→n vers Evidences, optional (scripted only)",
  "state_axes":     "n→n vers StateAxes, optional (scripted only)"
}
```

- **`engine`** : discriminant runtime.
- **`rules`** : JSON freeform — paramètres globaux du moteur scripted pour ce scénario
  (budget initial d'actions, seuils des paliers de score, ordre de précédence des fins).
  Cf. §8.
- `firstNode*` reste utilisé par le moteur free, ignoré par scripted (qui prend le start
  via `Node.is_start = true` filtré par `scenario`).

Champs existants : `title`, `prologue`, `lang`, `ai` restent — `ai` devient redondant
quand `engine='scripted'` (toujours `true` implicite) mais on le garde pour ne pas
casser le free.

#### `Node` — ajouts

```json
{
  "scenario":           "→ Scenario, optional but required if scripted",
  "external_id":        "text, optional (ex: 'N2.5' tel qu'écrit dans le PDF)",
  "is_start":           "bool, default=false",
  "prompt_ia":          "text, optional (instruction de classification par noeud)",
  "intents":            "json, optional (liste des labels d'intention acceptés et leur description)",
  "condition":          "json, optional (expression DSL §4)",
  "effects":            "json, optional (liste d'effets DSL §5)",
  "consumes_action":    "bool, default=true (scripted only)"
}
```

- `parent` reste utilisé en mode free (arbre joué). En mode scripted, l'arbre est encodé
  via `condition.from`/`condition.last` (cf. §4), pas via `parent` strict.
- `type` (`contribution`/`event`/`startNode`) reste pour le free ; en scripted on
  utilisera `is_start` pour le start, `type='contribution'` pour les autres.
- `session` reste *nullable* : un noeud scripted appartient au **scénario**, pas à une
  session.
- `external_id` permet de retrouver `N2.5` après import et de référencer dans les
  conditions.

#### `Session` — ajouts

```json
{
  "current_node":   "→ Node, optional (dernier noeud rendu, scripted only)",
  "visited_nodes":  "json array<string> — external_id ordonnés dans l'ordre de visite",
  "evidences":      "json array<string> — IDs ou external_id de preuves débloquées",
  "scores":         "json object<string, number> — ex: {conformite: 3, creativite: 1, eveil: 0}",
  "warnings":       "number, default=0",
  "actions_left":   "number, default=null (null si engine=free)",
  "last_intent":    "text, optional — dernière intention classifiée",
  "last_classification": "text, optional — pour 3036 (CONFORME/NON_CONFORME/CRITIQUE/NON_COOPERATIF)"
}
```

- Tous les champs nouveaux sont nullables/optionnels pour `engine='free'`.
- L'état complet d'une partie scripted est donc reconstructible en lisant `Session`.
- `current_node` + `visited_nodes` constituent le pointeur courant + l'historique
  topologique.

#### `End` — ajouts

```json
{
  "condition":  "json, optional (expression DSL §4)",
  "priority":   "number, default=0 (ordre de précédence si plusieurs matchent)"
}
```

- Cohabitation : `condition` non utilisé par le free (sélection manuelle), évalué par le
  scripted à chaque tour.

#### `Side` — gardé tel quel

`Side` reste un concept du moteur free (factions QG/Terrain). Pour les PNJ scripted on
introduit une nouvelle entité (§9).

### 3.3 Nouvelles collections

#### `Characters` (PNJ scripted)

```json
{
  "id":            "auto",
  "scenario":      "→ Scenario, required",
  "external_id":   "text (ex: 'nolan', 'elina')",
  "name":          "text (ex: 'Nolan Reyes')",
  "role":          "text optional (ex: 'PILOTAGE')",
  "bio":           "text optional"
}
```

Réf : `Scenario 2 N2.4` (liste des PNJ Helix avec rôles).

#### `Evidences` (preuves Helix-style)

```json
{
  "id":           "auto",
  "scenario":     "→ Scenario, required",
  "external_id":  "text (ex: 'P10_KIRA_A_ACCES_SUPERIEUR')",
  "label":        "text (libellé court affiché au joueur, ex: 'Kira a accès supérieur')",
  "description":  "text optional"
}
```

Réf : 10 preuves dans Helix (P1_SABOTAGE_CONFIRME ↔ P10_KIRA_A_ACCES_SUPERIEUR).

#### `StateAxes` (axes de score 3036-style)

```json
{
  "id":            "auto",
  "scenario":      "→ Scenario, required",
  "external_id":   "text (ex: 'conformite', 'creativite', 'eveil')",
  "label":         "text",
  "description":   "text optional"
}
```

Réf : `Scenario 3036` p.11 (score_conformite, score_creativite, score_eveil).

`warnings` reste un champ scalaire sur `Session` (cf. §3.2) — pas d'axe dédié car c'est
un compteur de seuil pas un score gradué.

### 3.4 Statut des champs existants

| Champ | Statut |
|---|---|
| `Scenario.firstNode*` | **Gardé**, ignoré en scripted (start lu via `Node.is_start`) |
| `Scenario.ai` | **Gardé** (utilisé par free), redondant en scripted |
| `Node.parent` | **Réutilisé** : conserve l'arbre joué en free ; en scripted, devient *parent suggéré* pour le rendu graph (sinon arbre purement plat ⇒ illisible) |
| `Node.type` | **Réutilisé** ; ajouter rien |
| `Node.audio`, `Node.author`, `Node.side` | **Gardés**, optionnels en scripted |
| `Session.events`, `Session.end` | **Gardés**. `end` reste 1↔1 (une session = une fin choisie) |
| `Side` | **Gardé**, hors-scope scripted |
| `Event` | **Gardé**, hors-scope scripted (sera peut-être réutilisé pour des `Event` Helix-style — à trancher en Phase 2) |
| `TriggerNodes` | **Déprécié** — collection inutilisée, supprimable en Phase 2 |
| `UserLevel` | **Gardé**, sans rapport |

## 4. DSL des conditions de déclenchement

### 4.1 Grammaire formelle (EBNF)

```ebnf
Condition  = Predicate | Combinator
Combinator = "all" ":" "[" Condition ("," Condition)* "]"
           | "any" ":" "[" Condition ("," Condition)* "]"
           | "not" ":" Condition
Predicate  = TopologyPred | IntentPred | TargetPred | EvidencePred
           | ScorePred | ActionsPred | ClassificationPred | WarningsPred
TopologyPred = "from" ":" NodeId             ; le joueur a visité ce noeud
             | "last" ":" "[" NodeId+ "]"    ; le dernier noeud visité ∈ liste
             | "visited" ":" "[" NodeId+ "]" ; tous les noeuds ont été visités
             | "after" ":" NodeId            ; alias pour `from`, plus explicite quand séquentiel
IntentPred = "intent_in" ":" "[" IntentLabel+ "]"
TargetPred = "target" ":" CharacterId
EvidencePred = "has" ":" EvidenceId
             | "has_any" ":" "[" EvidenceId+ "]"
             | "has_all" ":" "[" EvidenceId+ "]"
             | "has_count_gte" ":" Number  ; pour "≥3 preuves parmi…"
             | "has_count_among" ":" "{" "ids" ":" "[" EvidenceId+ "]" "," "gte" ":" Number "}"
ScorePred  = "score" ":" "{" "axis" ":" AxisId "," ("gte"|"lte"|"eq") ":" Number "}"
           | "score_level" ":" "{" "axis" ":" AxisId "," "level" ":" ("faible"|"moyen"|"eleve") "}"
ActionsPred = "actions_left" ":" "{" ("gte"|"lte"|"eq") ":" Number "}"
ClassificationPred = "classification_is" ":" ClassLabel
WarningsPred = "warnings" ":" "{" ("gte"|"lte"|"eq") ":" Number "}"
```

- Une condition vide ou absente ⇒ `true`.
- Le moteur évalue strictement (échec ⇒ noeud non éligible).
- Tous les `Pred` au top-level d'un objet sont implicitement reliés par `all`.

### 4.2 Évaluation `score_level`

Les paliers (`faible/moyen/eleve`) sont calculés à l'évaluation à partir du **max
théorique** déclaré dans `Scenario.rules.score_caps`. Décision utilisateur :

```yaml
score_caps:
  conformite: 6   # max atteignable en jouant parfaitement conforme
  creativite: 8
  eveil:      5
score_thresholds:
  faible: '<33%'
  moyen:  '33-66%'
  eleve:  '>66%'
```

Donc `score_level: {axis: conformite, level: eleve}` est équivalent à
`score: {axis: conformite, gte: 4}` (66% de 6 = 4).

### 4.3 Six exemples tirés littéralement des PDFs

**Ex 1 — Helix N2.1 (`État du vaisseau`)** :
> Condition : depuis N2, intention = COMPRENDRE

```yaml
condition:
  all:
    - from: N2
    - intent_in: [COMPRENDRE]
```

**Ex 2 — Helix N2.5 (`Accès supérieur`)** :
> Condition : depuis N2.4, intention = SYSTEME + accès élevé/protocole Helix/autorisation supérieure

```yaml
condition:
  all:
    - from: N2.4
    - intent_in: [SYSTEME]
    - intent_in: [ACCES_ELEVE, PROTOCOLE_HELIX, AUTORISATION_SUPERIEURE]
```

*(Note : « accès élevé/protocole Helix/autorisation supérieure » est traité comme un
sous-label d'intention, encodé dans `prompt_ia` du noeud — cf. §6.3. Si on veut éviter
la prolifération de labels, on peut le re-encoder comme un seul label
`SYSTEME_AUTORISATION_SUPERIEURE`, mais la version split est plus lisible.)*

**Ex 3 — Helix N4.2 (`Nolan et l'accès 03:07`)** :
> Condition : joueur possède P2_ACCES_0307 et mentionne 03:07/logs/heure

```yaml
condition:
  all:
    - has: P2_ACCES_0307
    - intent_in: [MENTIONNE_0307]
```

**Ex 4 — Helix N5.5 (`Elina réagit à directive Helix`)** :
> Condition : joueur possède P6_DIRECTIVE_HELIX et la montre à Elina

```yaml
condition:
  all:
    - has: P6_DIRECTIVE_HELIX
    - target: elina
    - intent_in: [PREUVE]
```

**Ex 5 — Helix N7.5 (`Kira sous pression`)** :
> Condition : joueur possède au moins 3 preuves parmi P2, P3, P6, P10 et confronte Kira

```yaml
condition:
  all:
    - target: kira
    - has_count_among:
        ids: [P2_ACCES_0307, P3_LOGS_EFFACES, P6_DIRECTIVE_HELIX, P10_KIRA_A_ACCES_SUPERIEUR]
        gte: 3
```

**Ex 6 — Helix N13.5 (`Accuser Kira avec preuves`)** :
> Condition : personnage accusé = Kira, preuves suffisantes : P6 + P10 + au moins une parmi P2/P3/P4

```yaml
condition:
  all:
    - intent_in: [ACCUSER_FINAL]
    - target: kira
    - has_all: [P6_DIRECTIVE_HELIX, P10_KIRA_A_ACCES_SUPERIEUR]
    - has_any: [P2_ACCES_0307, P3_LOGS_EFFACES, P4_AUTORISATION_MULTIPLE]
```

**Ex 7 bonus — 3036 N2A (`Animal conforme`)** :
> Condition : réponse classée CONFORME

```yaml
condition:
  all:
    - after: N2
    - classification_is: CONFORME
```

**Ex 8 bonus — 3036 Fin 1 (`Citoyen stable`)** :
> Condition : score_conformite élevé, score_creativite faible, score_eveil faible

```yaml
condition:
  all:
    - score_level: { axis: conformite, level: eleve }
    - score_level: { axis: creativite, level: faible }
    - score_level: { axis: eveil,      level: faible }
```

## 5. DSL des effets

### 5.1 Grammaire

```ebnf
Effects = "[" Effect+ "]"
Effect = "unlock" ":" EvidenceId
       | "score" ":" "{" "axis" ":" AxisId "," "delta" ":" Number "}"
       | "warnings" ":" "{" "delta" ":" Number "}"
       | "actions" ":" "{" "delta" ":" Number "}"   ; généralement -1 mais explicite
       | "set_classification" ":" ClassLabel        ; mémorise pour la suite
       | "end" ":" EndId                            ; force une fin (rare)
```

Les effets s'appliquent dans l'ordre déclaré, en série, après que l'IA ait classifié et
que le runtime ait sélectionné le noeud.

### 5.2 Exemples PDF

**Ex 1 — Helix N2.1** (cf. ligne du PDF : `Preuve débloquée : P1_SABOTAGE_CONFIRME`) :

```yaml
effects:
  - unlock: P1_SABOTAGE_CONFIRME
```

**Ex 2 — Helix N2.2** (`Preuves débloquées : P2_ACCES_0307, P3_LOGS_EFFACES`) :

```yaml
effects:
  - unlock: P2_ACCES_0307
  - unlock: P3_LOGS_EFFACES
```

**Ex 3 — 3036 N2C (`Animal critique`)** (`score_creativite +2, score_eveil +1`) :

```yaml
effects:
  - score: { axis: creativite, delta: 2 }
  - score: { axis: eveil,      delta: 1 }
```

**Ex 4 — 3036 N2D (`Animal non coopératif`)** (`score_creativite +2, avertissement +1`) :

```yaml
effects:
  - score: { axis: creativite, delta: 2 }
  - warnings: { delta: 1 }
```

**Ex 5 — Helix N12 (`Montrer preuve à Kira`, conditionnel)** :
> Effet : si P6 + P10 possédées, débloque N7_5_KIRA_PRESSION.

→ on ne supporte pas les effets conditionnels intra-noeud ; on encode N7.5 comme un
**noeud séparé** avec sa propre `condition` (`has_count_among` ≥3 parmi P2/P3/P6/P10).
C'est ce qui est déjà écrit ailleurs dans le PDF. **Pas besoin d'effet conditionnel.**

**Ex 6 — Implicite, tous les noeuds Helix** : `actions: { delta: -1 }` est appliqué
automatiquement par le runtime si `Node.consumes_action = true` ; pas besoin de le
déclarer dans `effects`. Seules les exceptions (N13.x accusation : `consumes_action:
false`) sont explicites.

## 6. Contrat IA

### 6.1 Nouvel endpoint Go : `POST /api/classify`

Remplace fonctionnellement `/api/checkMsg` pour le moteur scripted. `/api/checkMsg`
reste en place pour le moteur free. `/api/health` reste inchangé.

#### Payload IN

```json
{
  "session":       "string (ID session)",
  "node_prompt":   "string (le prompt_ia du noeud parent — instructions de classification)",
  "intents":       [
    { "label": "COMPRENDRE",  "description": "joueur demande de l'état général / pourquoi" },
    { "label": "SYSTEME",     "description": "joueur veut interagir avec le système, réparer, etc." },
    { "label": "INTERROGER",  "description": "joueur pose une question générale à l'équipage" },
    { "label": "OBSERVER",    "description": "joueur reste passif, regarde, écoute" }
  ],
  "player_text":   "string (texte saisi par le joueur)",
  "session_state": {
    "visited_nodes":   ["N1", "N2", "N2.1"],
    "evidences":       ["P1_SABOTAGE_CONFIRME"],
    "scores":          { "conformite": 2, "creativite": 1, "eveil": 0 },
    "warnings":        0,
    "actions_left":    14,
    "last_intent":     "COMPRENDRE",
    "last_classification": null
  }
}
```

#### Payload OUT

```json
{
  "intent":      "SYSTEME",
  "confidence":  0.84,
  "rationale":   "le joueur demande de réparer la navigation",
  "alternatives": [
    { "label": "COMPRENDRE", "confidence": 0.12 }
  ]
}
```

#### Comportement

- Le Go ne **décide pas** quel noeud déclencher. Il classifie l'intention, le runtime
  SvelteKit fait le filtrage de noeuds éligibles + applique conditions.
- Si `confidence < seuil` (configurable, ex 0.5), le runtime peut afficher un noeud de
  fallback (`is_fallback: true` sur un Node, ou un message « réessayez ») au lieu de
  forcer un match.
- `session_state` est transmis pour permettre à un LLM (si on backte plus tard) de
  raisonner. Pour le classifier word2vec actuel, ce champ est ignoré.

#### Implémentation Go

Le code existant `IsActionPerformed` (`censorship.go:194-237`) peut être adapté en
*intent matcher* : pour chaque label d'intention, on a une description, on calcule la
cosine similarity entre `player_text` et chaque description (word2vec), on prend
l'argmax + threshold. C'est la version basique. La version LLM-backed (Phase 7,
Mistral AI — cf. §12 Phase 7) peut venir plus tard sans changer le contrat. À la
différence du backend word2vec, le LLM peut **aussi** poser le champ
`classification` (CONFORME / NON_CONFORME / CRITIQUE / NON_COOPERATIF / RIEN /
CREATIF / EVEIL — taxonomie 3036), ce que word2vec ne peut pas faire faute de
sémantique au-delà de la similarité cosinus.

### 6.2 Cohabitation avec `/api/checkMsg`

- `Scenario.engine === 'free'` ⇒ runtime SvelteKit appelle `/api/checkMsg` (inchangé).
- `Scenario.engine === 'scripted'` ⇒ runtime appelle `/api/classify` à chaque
  contribution joueur.
- Le serveur Go gère deux états par session (un `Session` censorship pour free, un
  `ScriptedSession` minimal pour scripted ne stockant rien — l'état canonique vit en
  BD).

### 6.3 Format des `intents` par noeud

Chaque noeud déclare la liste des intentions qu'il est prêt à reconnaître, avec une
description issue de son `prompt_ia` du PDF :

```yaml
- id: N2
  prompt_ia: "déclencher si le joueur parle du terminal, du système, des erreurs..."
  intents:
    - label: COMPRENDRE
      description: "le joueur veut comprendre ce qui se passe"
    - label: SYSTEME
      description: "le joueur parle du terminal, des erreurs, de la navigation"
```

Le runtime construit le payload `intents[]` à partir de l'union des intentions
déclarées par les **noeuds enfants éligibles** du noeud courant (cf. §7).

## 7. Runtime d'une session scripted

### 7.1 Machine à états

```
État ::= { current_node, visited_nodes, evidences, scores, warnings, actions_left,
           last_intent, last_classification, ended_with: EndId | null }

Tour ::= état_t → joueur_input → état_{t+1}
```

Transitions terminales : `ended_with !== null` ⇒ session figée, `Session.completed=true`,
`Session.end = ended_with`.

### 7.2 Ordre d'évaluation à chaque tour

```
1. Le joueur soumet `player_text` (form action addNode, comme aujourd'hui).
2. Le runtime calcule les NOEUDS CANDIDATS :
   candidates = tous les Node du scénario tels que:
     - is_start = false
     - leur condition ne dépend pas d'intent/classification est déjà vraie
       OU dépend d'intent/classification (on classifie ensuite)
3. Si parmi `candidates` aucun ne dépend de l'intent ⇒ on saute le call IA.
4. Sinon, on construit `intents[]` = union des intents déclarés par les candidates qui
   en utilisent.
5. POST /api/classify avec node_prompt = current_node.prompt_ia (ou un prompt système
   par défaut), intents, player_text, session_state.
6. On récupère `intent` + `confidence`. Si confidence < seuil → fallback (cf. 7.3).
7. On filtre `candidates` en ré-évaluant chaque condition avec l'intent connu.
8. On TRIE les survivants par specificité descendante :
   - nombre de prédicats matchés (un noeud avec `has`+`has_any`+`target` > un avec
     juste `intent_in`)
   - puis par priorité explicite (`Node.priority`, ajoutable plus tard si besoin)
9. On prend le PREMIER survivant comme `next_node`.
10. On applique les effets de `next_node` dans l'ordre déclaré (§5).
11. On décrémente `actions_left` si `consumes_action = true`.
12. On évalue toutes les `End.condition` dans l'ordre de `End.priority` desc.
    Si une match ⇒ `ended_with = endId` et on s'arrête après avoir rendu le texte du
    noeud + le texte de la fin.
13. On persiste l'état mis à jour sur Session + on crée un nouveau Node record
    représentant la contribution joueur + on stocke `current_node = next_node`.
14. On retourne au client : texte de `next_node`, état mis à jour, fin éventuelle.
```

### 7.3 Fallback si aucun candidat ne match

- Si après §7.2 étape 7 il reste 0 candidats : on rend un **noeud de fallback générique**
  par scénario (déclaré dans `Scenario.rules.fallback_node`), sans consommer d'action.
- Si la confidence est trop basse : idem.

Exemple type fallback Helix : « Tu hésites. Reformule. »

### 7.4 Why `current_node` matters

Bien que la sélection se fasse par DSL (et pas par `parent` strict), on garde un
pointeur `current_node` parce que :
- `prompt_ia` de l'IA est *celui du noeud courant* (le joueur répond à ce qu'on vient de
  lui dire) — cf. exemples Helix où le prompt IA est rattaché à un noeud ;
- pour le rendu graph (`MainGraph.svelte`), on hérite de la position visuelle ;
- pour `from`/`last` conditions, c'est efficace de comparer à un pointeur unique.

## 8. Modèle des fins

### 8.1 Coexistence de plusieurs fins

Plusieurs `End` records par scénario (déjà supporté). Chacun porte :

- `condition` (DSL §4) — quand cette fin est-elle éligible ;
- `priority` — entier, défaut 0, plus élevé = évalué en premier ;
- `title`, `text` — déjà existants.

### 8.2 Ordre de précédence

À chaque tour, après application des effets du noeud sélectionné :
1. Évaluer toutes les `End.condition` du scénario courant.
2. Trier les `End` éligibles par `priority` décroissante.
3. Prendre le premier ⇒ session terminée.
4. Si 0 éligibles ⇒ continuer.

Exemple Helix (3 fins) :

```yaml
ends:
  - external_id: FIN_REUSSITE
    priority: 30
    condition:
      all:
        - visited: [N13.5]    # accusation correcte de Kira avec preuves

  - external_id: FIN_ECHEC_TEMPS
    priority: 20
    condition:
      all:
        - actions_left: { lte: 0 }

  - external_id: FIN_ECHEC_ACCUSATION
    priority: 10
    condition:
      any:
        - visited: [N13.1]   # accusation Nolan
        - visited: [N13.2]   # accusation Elina
        - visited: [N13.3]   # accusation Arman
```

`priority` est cruciale : si le joueur fait une accusation correcte au tour `t` alors
qu'`actions_left` tombe à 0 *au même tour*, on veut FIN_REUSSITE pas FIN_ECHEC_TEMPS.

### 8.3 Exemple 3036 (5 fins, conditions par paliers de score)

```yaml
ends:
  - external_id: FIN_INTERROMPUE
    priority: 50
    condition:
      warnings: { gte: 2 }   # à valider : 2 ou 3 ?

  - external_id: FIN_EVEILLE
    priority: 40
    condition:
      score_level: { axis: eveil, level: eleve }

  - external_id: FIN_REEDUCATION_EXPRESSIVE
    priority: 30
    condition:
      all:
        - score_level: { axis: creativite, level: eleve }
        - any:
            - score_level: { axis: eveil, level: faible }
            - score_level: { axis: eveil, level: moyen }

  - external_id: FIN_SURVEILLANCE_LEGERE
    priority: 20
    condition:
      all:
        - score_level: { axis: creativite, level: moyen }
        - any:
            - score_level: { axis: eveil, level: faible }
            - score_level: { axis: eveil, level: moyen }

  - external_id: FIN_CITOYEN_STABLE
    priority: 10
    condition:
      all:
        - score_level: { axis: conformite, level: eleve }
        - score_level: { axis: creativite, level: faible }
        - score_level: { axis: eveil,      level: faible }
```

Les fins ne sont évaluées qu'**après le dernier exercice** (N7 dans 3036) ; pour
éviter qu'une fin se déclenche en plein milieu, on peut ajouter
`Scenario.rules.end_eval_after: NodeId` (par défaut `null` = à chaque tour, comme Helix).
Pour 3036 ⇒ `end_eval_after: N7`.

## 9. PNJ vs Side

**Décision** : nouvelle entité `Characters` (cf. §3.3), pas extension de `Side`.

### Justification

| Critère | `Side` étendu | `Characters` nouveau |
|---|---|---|
| Sémantique | Faction collective (QG, Terrain) — pluriel par nature | PNJ individuel — singulier par nature |
| Hardcoding actuel | `ia_server/pkg/censorship/session.go:29` hardcode `qg`/`terrain` | aucun |
| Champs utiles | `name` | `name`, `role`, `bio` |
| Réutilisation par le free | OUI, breaker de compat si on change | n/a, isolé |
| Risque de régression | élevé (touche scénario.json Go, censorship/) | nul (collection nouvelle) |

Côté Helix, on a 4 personnages (Nolan, Elina, Arman, Kira) chacun avec un `role`
explicite (PILOTAGE / SCIENCE / MÉDICAL / SÉCURITÉ HELIX) — sémantiquement c'est un
PNJ individuel, pas une faction. Un personnage n'a pas vocation à être assigné comme
`side` d'un noeud (au sens free).

`Characters` est référencé par les conditions via `target: nolan` (§4) et alimente
l'UI admin pour saisir les noeuds des branches PNJ.

`Side` reste utilisable pour des scénarios scripted multi-joueurs *plus tard* (pas le
cas des 2 PDFs actuels).

## 10. Authoring

### 10.1 UI admin (refonte de `admin/scenario/create`)

Pour l'instant `create/+page.svelte` est un formulaire mono-page. En scripted, on aura
besoin de :

1. **Étape 1 — Métadonnées scenario** : `title`, `prologue`, `engine='scripted'`,
   `lang`. Inchangé visuellement.
2. **Étape 2 — Déclaration des `Characters`** : tableau éditable avec nom, role, bio.
3. **Étape 3 — Déclaration des `Evidences`** : tableau éditable (external_id, label,
   description).
4. **Étape 4 — Déclaration des `StateAxes`** : tableau éditable + caps + thresholds
   globaux (`Scenario.rules.score_caps`, `score_thresholds`).
5. **Étape 5 — Graphe de noeuds** : import YAML (cf. 10.2) **ou** édition visuelle
   (Phase 4+). Pour Phase 2 on se contente du bouton « importer YAML ».
6. **Étape 6 — Fins** : tableau éditable avec `external_id`, `priority`, `condition`
   (saisi en YAML brut dans un textarea), `title`, `text`.

L'édition visuelle de la condition DSL est hors-scope (Phase 5+). On édite en YAML brut.

### 10.2 Format fixture YAML

Décision utilisateur : YAML.

Squelette d'un fixture par scénario :

```yaml
scenario:
  external_id: helix_corp
  title: Helix Corp
  prologue: |
    Helix Corp est partout. Ce sont eux qui financent les stations…
  lang: fr-FR
  engine: scripted

rules:
  initial_actions: 18
  score_caps: {}
  score_thresholds:
    faible: '<33%'
    moyen:  '33-66%'
    eleve:  '>66%'
  fallback_node: NF_HESITE
  end_eval_after: null   # évalue à chaque tour

characters:
  - external_id: nolan
    name: Nolan Reyes
    role: PILOTAGE
  - external_id: elina
    name: Dr Elina Voss
    role: SCIENCE / MISSION KEPLER-9
  - external_id: arman
    name: Arman Delaunay
    role: MÉDICAL / BIO-SÉCURITÉ
  - external_id: kira
    name: Kira Solis
    role: SÉCURITÉ HELIX

evidences:
  - external_id: P1_SABOTAGE_CONFIRME
    label: Sabotage confirmé
  - external_id: P2_ACCES_0307
    label: Accès manuel à 03:07
  # …P3..P10

state_axes: []   # Helix n'a pas de scores graduées

nodes:
  - external_id: N1
    titre: RÉVEIL
    is_start: true
    texte: |
      Tu es réveillé par le bruit strident d'une alarme…
    consumes_action: true

  - external_id: N2
    titre: TERMINAL PRINCIPAL
    texte: |
      Le terminal mural s'allume lentement…
    prompt_ia: "déclencher si le joueur parle du terminal, du système, des erreurs, de la navigation, de l'état du vaisseau ou d'une tentative de réparation, uniquement après le Noeud 1."
    intents:
      - label: COMPRENDRE
        description: le joueur veut comprendre l'état général
      - label: SYSTEME
        description: le joueur veut interagir avec le système, réparer
    condition:
      any:
        - intent_in: [COMPRENDRE]
        - intent_in: [SYSTEME]
      all:
        - from: N1
    consumes_action: true

  - external_id: N2.5
    titre: ACCÈS SUPÉRIEUR
    texte: |
      Tu compares les niveaux d'accès…
    prompt_ia: "déclencher si le joueur cherche quel profil peut masquer un identifiant…"
    intents:
      - label: SYSTEME
        description: accès élevé, protocole Helix, autorisation supérieure
    condition:
      all:
        - from: N2.4
        - intent_in: [SYSTEME]
    effects:
      - unlock: P10_KIRA_A_ACCES_SUPERIEUR
    consumes_action: true

  # … N3..N14

ends:
  - external_id: FIN_REUSSITE
    title: Fin — Réussite
    priority: 30
    text: |
      La tension explose. Nolan force Kira à reculer…
    condition:
      visited: [N13.5]

  - external_id: FIN_ECHEC_TEMPS
    title: Fin — Échec temps
    priority: 20
    text: |
      Le compte à rebours arrive à zéro…
    condition:
      actions_left: { lte: 0 }

  - external_id: FIN_ECHEC_ACCUSATION
    title: Fin — Échec accusation
    priority: 10
    text: |
      Tu as accusé trop vite…
    condition:
      any:
        - visited: [N13.1]
        - visited: [N13.2]
        - visited: [N13.3]
```

### 10.3 Validation à l'import

- Zod schema YAML (nouveau dans `src/lib/zschemas/scripted-scenario.schema.ts`) avec
  discriminated union sur les `condition` predicates.
- Validation référentielle : toute `EvidenceId` mentionnée dans une condition doit
  exister dans `evidences[]`, idem `CharacterId`, idem `NodeId`.
- Validation graphe : avertir si un noeud n'a aucun chemin depuis le start.

## 11. Rétrocompat

Décision utilisateur : **cohabitation via flag `engine`**.

### 11.1 Code branches

- `src/routes/sessions/[slug=number]/+page.server.ts` :
  - load : si `scenario.engine === 'scripted'`, charger l'état scripted complet
    (`session.visited_nodes`, `session.evidences`, etc.).
  - action `addNode` : branche sur engine.
    - `free` : code actuel (`censorNode`, multipath, etc.). Intouché.
    - `scripted` : nouvelle fonction `progressScripted()` qui exécute §7.2.
  - actions `addEvent`, `endSession` : conservées **mais affichées en lecture seule
    pour les scénarios scripted** (l'admin ne pousse pas d'event, n'end pas
    manuellement — le moteur le fait).
- `MainGraph.svelte` : sait afficher les deux types ; en scripted, l'arbre rendu est
  celui des `visited_nodes` ordonnés par `current_node` chain.

### 11.2 Données existantes

- Tous les `Scenario` actuels reçoivent `engine = 'free'` par défaut (migration BD
  triviale, valeur par défaut). Pas de rewrite de données.
- Les nouvelles collections (`Characters`, `Evidences`, `StateAxes`) sont vides pour les
  scénarios `free` — aucun impact.

### 11.3 Quand peut-on supprimer le `free` ?

Hors scope de cette Phase 0. Si jamais on migre tout vers scripted plus tard, on peut
décommissionner `/api/checkMsg`, le scenario JSON Go et la moitié de `censorship/` —
mais ça implique de migrer les `event QG/Terrain`. À reconsidérer Phase 6+.

## 12. Plan de phases suivantes

Chaque phase a un critère de sortie **testable**. La Phase 0 (celle-ci) sort dès que ce
doc est validé.

### Phase 1 — Encoder les 2 PDFs en fixtures YAML [LIVRÉE — 2026-05-25]

**Livrable** : 2 fichiers `scenarios/fixtures/helix-corp.yaml`,
`scenarios/fixtures/3036.yaml`, conformes au format §10.2.

**Critère de sortie** :
- 100% des noeuds des PDFs encodés (compter ≈ 50 noeuds pour Helix, ≈ 25 pour 3036).
- Toutes les preuves Helix (P1..P10) déclarées + référencées au moins une fois.
- Toutes les fins déclarées avec leur `condition`.
- Validation manuelle : faire lire le YAML à un autre humain, qui doit pouvoir
  retracer mentalement les bifurcations du PDF.

### Phase 2 — Migration de schéma BD + Zod schemas [LIVRÉE — 2026-05-25]

**Livrable** : `db/schema.json` patché avec :
- champs additifs sur `Scenario`, `Node`, `Session`, `End` ;
- 3 nouvelles collections (`Characters`, `Evidences`, `StateAxes`) ;
- collection `TriggerNodes` supprimée (gardée si on hésite — à trancher ici).
- `src/lib/zschemas/scripted-scenario.schema.ts` créé avec validation complète.

**Critère de sortie** :
- `pnpm check` passe.
- L'import d'un fixture YAML produit en BD un scénario complet (test unit avec une
  partie du fixture Helix).
- Un scénario `engine='free'` existant continue à fonctionner (test : ouvrir
  `/sessions/<slug_free>`, créer une contribution, vérifier que `/api/checkMsg` est
  toujours appelé).

### Phase 3 — Moteur narratif pur + tests Vitest [LIVRÉE — 2026-05-25]

> Note (2026-05-25) : la Phase 3 originale (« Endpoint Go `/api/classify` + runtime
> SvelteKit ») a été éclatée à l'exécution. Seul le **moteur pur** a été livré ici ;
> le Go classify + le runtime SvelteKit + la branche `addNode` ont été reportés en
> Phase 5 et Phase 6 (cf. ci-dessous).

**Livré** :
- `src/lib/narrative/` : `types.ts`, `compile.ts`, `conditions.ts`, `effects.ts`,
  `engine.ts`, `yaml.ts`, `index.ts` — moteur hermétique, aucune dépendance vers
  `$lib/i18n` ni Svelte.
- `tests/units/narrative/{conditions,engine-helix,engine-3036,fixtures,schema}.test.ts`
  — 50 tests à la livraison, étendus à 92 après Phase 3bis.

**Critère de sortie atteint** : `pnpm test:narrative` ✅, parcours canoniques Helix
(REUSSITE / ECHEC_TEMPS / ECHEC_ACCUSATION) et 3036 (5 fins) couverts par tests E2E.

### Phase 3bis — Polish moteur (refines Zod, validation référentielle, clamp) [LIVRÉE — 2026-05-25]

**Livré** : 6 commits `fix(narrative): …` corrigeant les pièges silencieux identifiés
en review d'ensemble Phases 1-3 (refines Zod sur prédicats numériques, refuse
`condition: {}`, propagation du numéro de ligne YAML, unicité des `external_id` sur
les 5 collections, test de régression cross-module sur `validateReferences`, clamp
`actions_left` à 0).

**Critère de sortie atteint** : 92/92 tests passent (74 → 92, +18). Phase-reviewer
PASS.

### Phase 4 — Authoring scripted via import YAML [LIVRÉE — 2026-05-25]

**Livré** :
- `src/routes/admin/scenario/import/` (page + form action `importFixture`).
- `src/lib/scenario/{pb-id,validate-references,persist-scripted}.ts` — pipeline
  `parseYaml → safeParse → compile → validateReferences → persistCompiledScenario`
  avec batch transactionnel PocketBase 0.26.
- Drop de la collection `TriggerNodes` inutilisée.
- `RUNBOOK.md` + subagent `runbook-keeper` introduits comme byproduct (Batch API
  doit être activée côté PB sinon 403).

**Critère de sortie atteint** : un superAdmin importe `helix-corp.yaml` (47 noeuds,
10 preuves, 4 PNJ, 3 fins) en une transaction. Tests d'intégration avec mock PB.

### Phase 5 — Runtime scripted (serveur + UI joueur)

**Objectif** : un superAdmin peut créer une session scripted depuis
`/admin/sessions/create`, et un joueur peut la jouer du début à la fin dans le
navigateur jusqu'à atteindre une fin déclenchée par l'état (preuves + scores +
actions).

**Sous-tâches gatées** (chaque sous-tâche = un task dans le TaskCreate de
`/phase start 5` ; le critère de sortie de la phase n'est validé que quand les 5
sous-tâches sont vertes et `phase-reviewer` PASS) :

- **5.1 — Session admin scripted.** `/admin/sessions/create` accepte les scénarios
  `engine: 'scripted'` (dropdown filtré, branchement de `createStartNode` selon
  `engine`). Pas de UI joueur encore, juste créer la session avec le bon
  `current_node`, `visited_nodes`, `actions_left`, `scores`, `evidences` initiaux
  (cf. `initialState()` de `$lib/narrative/types.ts`). Tests unit serveur.
- **5.2 — Stub classifieur TS.** `src/lib/narrative/classify-stub.ts` exposant
  `classifyStub(text: string, prompt_ia: string, intents: string[]): { intent:
  string; classification?: string; confidence: number }`. Stratégie : keyword
  matching + fallback premier intent déclaré. Hermétique (rien de Svelte ni i18n).
  Tests Vitest sur ≥10 phrases joueur tirées des PDFs (Helix et 3036).
- **5.3 — Runtime serveur.** `src/lib/scenario/runtime-scripted.ts` exposant
  `progressScripted(pb, sessionId, playerText, classifier): Promise<StepResult>`
  qui (a) charge le `Scenario` + `Session` PB, (b) compile, (c) appelle le
  classifier, (d) appelle `engine.step()`, (e) persiste `current_node`,
  `visited_nodes`, `evidences`, `scores`, `actions_left`, `last_intent`,
  `last_classification`, `ended_with` dans la `Session` PB, et (f) si
  `ended_with !== null` positionne `Session.completed = true` et `Session.end`.
  Tests d'intégration avec mock PB.
- **5.4 — Branche dans `addNode` form action.** `src/routes/sessions/[slug=number]/+page.server.ts`
  detect `Scenario.engine`. Si `'scripted'`, route vers `progressScripted()` au
  lieu du chemin free. Le retour expose le `next_node` rendu + l'état mis à jour
  à la page joueur. Test de régression : un scénario `engine: 'free'` continue à
  fonctionner pixel-pour-pixel.
- **5.5 — UI joueur scripted.** Nouvelle vue Svelte rendue quand
  `Scenario.engine === 'scripted'` (à la place de `MainGraph.svelte`). Affiche le
  texte du noeud courant + input texte du joueur + sidebar (preuves débloquées,
  scores, actions restantes). Affichage de la fin atteinte. **Supervisé** —
  vérification visuelle nécessaire, pas de hook auto-test pour le rendu.

**Critère de sortie de la Phase 5** :
- Une partie complète Helix peut être jouée du début à la fin dans le navigateur
  jusqu'à `FIN_REUSSITE` (test manuel).
- Une partie complète 3036 atteint au moins `FIN_CITOYEN_STABLE` et
  `FIN_EVEILLE` selon les réponses (test manuel).
- L'état (preuves, scores, actions) est visible et mis à jour en temps réel.
- Test automatisé : un scénario free joué dans la même session continue à
  fonctionner.
- `pnpm test:narrative` reste à 92/92+ (les sous-tâches 5.2-5.3 ajoutent ≥10
  tests serveur).

### Phase 6 — Endpoint Go `/api/classify` (word2vec)

**Livrable** :
- `ia_server/webservice/classify.go` : nouveau handler, payload §6.1.
- `src/lib/server/ia/classify.ts` : client TS qui remplace l'usage du stub TS de
  Phase 5.2 dans `progressScripted()`.
- Feature flag d'ENV : `IA_CLASSIFY_BACKEND=stub|word2vec` côté SvelteKit pour
  basculer entre le stub TS (dev / tests) et le Go word2vec (prod). Le stub n'est
  **pas** supprimé — il reste l'implémentation par défaut en absence de Go server.

**Critère de sortie** :
- `/api/classify` retourne une intent + confidence sur un payload de test (test
  d'intégration Go avec word2vec).
- Une partie complète Helix jouée avec `IA_CLASSIFY_BACKEND=word2vec` produit les
  mêmes noeuds que le stub sur ≥80% des inputs (corpus de test à monter).

### Phase 7 — LLM-backed `/api/classify` (Mistral AI, optionnel)

**Choix du fournisseur** : Mistral AI. Justification : le projet, l'UI et les
prompts narratifs (fixtures YAML, descriptions d'intent) sont en français ;
Mistral est entraîné nativement sur du français de bonne qualité et est hébergé
en UE (souveraineté des données joueur). Pas de SDK Go officiel ; on appelle
l'API REST `https://api.mistral.ai/v1/chat/completions` (format compatible
OpenAI) en HTTP direct depuis `classify.go` — aucune dépendance externe à
ajouter dans `go.mod`.

**Modèle par défaut** : `mistral-small-latest` (latence + coût les plus bas du
catalogue, suffisant pour une tâche de classification courte sur input français
< 200 mots). Override possible via env var `MISTRAL_MODEL` (ex.
`mistral-medium-latest` si la précision tombe sous le seuil §critère de sortie).

**Garanties de format** : utiliser `response_format: { type: "json_object" }`
dans la requête pour forcer un JSON parseable côté Go. Schéma de retour :
`{intent, confidence, classification?, rationale}` — `classification` est
optionnel et n'est posé que si le `prompt_ia` contient une taxonomie type 3036
(ce que le backend word2vec ne peut PAS faire — cf. §6.1 Implémentation Go).

**Variables d'environnement (Go)** :
- `MISTRAL_API_KEY` (requis, privé) — clé API Mistral.
- `MISTRAL_MODEL` (optionnel, défaut `mistral-small-latest`) — override modèle.

**Livrable** :
- `ia_server/pkg/classify/llm.go` : client HTTP Mistral pur (`ClassifyLLM(model,
  apiKey, playerText, promptIa, intents) → IntentResult`). Sans état.
- `ia_server/webservice/classify.go` étendu : sélection du backend selon une
  variable d'env Go (`CLASSIFY_BACKEND=word2vec|llm`, défaut `word2vec`) — un
  seul endpoint `/api/classify`, le switch est interne au handler.
- `src/lib/server/ia/classify.ts` : extension de `pickClassifier()` pour accepter
  la valeur `llm` côté SvelteKit (le client TS reste identique car l'endpoint Go
  est le même — seul le backend interne change).

**Fallback** : si l'API Mistral est down ou si `MISTRAL_API_KEY` n'est pas
défini, le handler Go retombe sur le word2vec (warning log). Si word2vec est
aussi indisponible (model.bin absent), 503 + le client TS retombe en no-match.

**Critère de sortie** :
- Latence < 2s P95 pour un classify (P95 mesuré sur 50 requêtes hors cold-start).
- Sur un corpus de 50 inputs joueur scriptés à la main, classification LLM > 90%
  vs word2vec ≈ 60% (à valider expérimentalement).
- Feature flag étendu : `IA_CLASSIFY_BACKEND=stub|word2vec|llm`.
- La dette 3036 héritée de Phase 6 (word2vec ne pose pas `classification`) est
  résolue côté `llm`.

### Phase 8+ — Édition visuelle des conditions, statistiques par scénario, multi-joueur scripted

Hors-scope pour le moment ; à re-planifier après Phase 7.

## 13. Risques et inconnues

Les choix arbitraires ci-dessous sont à valider avant Phase 1 — ils sont actuellement
*tranchés mais pas figés* :

1. **3036 — seuil de `warnings` qui déclenche `FIN_INTERROMPUE`** : le PDF dit
   « réponses non coopératives répétées » sans préciser le seuil. Tranché ici à
   `warnings ≥ 2`, à valider en jouant le scénario.

2. **3036 — `end_eval_after`** : tranché à `N7` (dernier noeud d'exercice). Si on
   évalue trop tôt, une fin se déclenche au milieu du jeu. À vérifier qu'aucun chemin
   ne saute N7.

3. **Helix — sous-labels d'intent** : « accès élevé / protocole Helix / autorisation
   supérieure » dans N2.5 peuvent être encodés (a) comme 3 labels séparés
   (`ACCES_ELEVE`, etc.) **ou** (b) en un seul `SYSTEME_AUTORISATION_SUPERIEURE`. La
   version (a) est plus fine mais demande au classifier d'être plus précis. À tester
   en Phase 3.

4. **Helix — N5.5 vs N10** : N5.5 (« Elina réagit à directive Helix » conditionné par
   P6 + cible Elina) est sémantiquement quasi-identique au cas P6 dans N10 (« Montrer
   preuve à Elina, si P6 »). On les encode comme **deux noeuds distincts** parce que
   les `prompt_ia` diffèrent légèrement, mais c'est de la duplication potentielle.
   À vérifier auprès de l'auteur des PDFs.

5. **Confidence threshold du classify** : valeur par défaut tranchée à `0.5`. Devra
   être tunée empiriquement.

6. **Specificité du matching** : §7.2 étape 8 trie par « nombre de prédicats matchés ».
   C'est une heuristique simple ; un noeud très contraint sera toujours plus
   spécifique qu'un noeud générique. Mais si deux noeuds ont le même nombre de
   prédicats, l'ordre dépend de l'ordre d'insertion en BD — non déterministe. À
   confirmer qu'on accepte ce non-déterminisme (et qu'aucune paire de noeuds Helix /
   3036 ne se retrouve dans ce cas), ou bien ajouter un champ `Node.priority`.

7. **Effets conditionnels** : §5 dit qu'on ne supporte pas `if cond then effect`.
   Cette décision est ferme : on duplique en noeuds. Si l'auteur ajoute beaucoup
   d'effets conditionnels en Phase 1, on reverra.

8. **Persistance de l'état sur Session** : champs JSON. PocketBase n'a pas de
   schéma rigide sur ces champs → risque de drift. On compense avec un Zod schema
   appliqué au read et write.

9. **Multi-onglets / concurrence** : le joueur ouvre la même session dans 2 onglets et
   envoie 2 contributions ⇒ états divergents. À régler avec un lock optimiste
   (`Session.updated` etag) en Phase 3 ou 5.

10. **`TriggerNodes` (collection inutilisée)** : on hésite entre la supprimer en
    Phase 2 et la garder « au cas où ». Décision actuelle : supprimer. À confirmer.

11. **`hidden` type dans TypeScript mais pas en BD** (cf. `TableTypes.ts:3`) : non
    lié au scripted, mais à nettoyer pour cohérence. Hors-scope Phase 0.

## Fichiers critiques à modifier (référence)

| Fichier | Phase | Nature |
|---|---|---|
| `db/schema.json` | 2 | additif (4 collections, champs sur 4 existantes) |
| `src/lib/zschemas/scripted-scenario.schema.ts` | 2 | nouveau |
| `src/types/pocketBase/TableTypes.d.ts` | 2 | régénération depuis schema |
| `src/lib/scripted/runtime.ts` | 3 | nouveau, cœur du moteur |
| `src/lib/scripted/dsl.ts` | 3 | nouveau, évaluateur conditions + effets |
| `src/lib/server/ia/classify.ts` | 3 | nouveau, client `/api/classify` |
| `src/routes/sessions/[slug=number]/+page.server.ts:11-99` | 3 | branche `engine` dans `addNode` |
| `ia_server/webservice/classify.go` | 3 | nouveau handler |
| `ia_server/webservice/server.go:51` | 3 | route nouvelle |
| `src/routes/admin/scenario/create/+page.svelte` | 4 | refonte multi-étapes |
| `src/routes/admin/scenario/create/+page.server.ts` | 4 | action d'import YAML |
| `src/components/MainGraph.svelte` | 5 | rendu scripted |
| `scenarios/fixtures/helix-corp.yaml` | 1 | nouveau fixture |
| `scenarios/fixtures/3036.yaml` | 1 | nouveau fixture |

## Vérification de la Phase 0

Cette phase n'a pas de code à exécuter. La sortie est ce document. Le critère :
l'utilisateur (toi) le relit, on itère sur les ambiguïtés du §13, et on tague la phase
finie au moment du « go Phase 1 ».
