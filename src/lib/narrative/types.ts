// Runtime types pour le moteur narratif scripted.
// HERMÉTIQUE : ne dépend que de zschemas/scripted-scenario.schema (lui-même hermétique).

import type {
	CharacterFixture,
	Condition,
	Effect,
	EndFixture,
	EvidenceFixture,
	NodeFixture,
	ScenarioRules,
	ScriptedScenarioFixture,
	StateAxisFixture
} from '../zschemas/scripted-scenario.schema';

export type {
	CharacterFixture,
	Condition,
	Effect,
	EndFixture,
	EvidenceFixture,
	NodeFixture,
	ScenarioRules,
	ScriptedScenarioFixture,
	StateAxisFixture
};

/** État runtime d'une session scripted (cf. design doc §3.2 / §7.1). */
export interface SessionState {
	current_node: string | null;
	visited_nodes: string[];
	evidences: string[];
	scores: Record<string, number>;
	warnings: number;
	actions_left: number | null;
	last_intent: string | null;
	last_classification: string | null;
	ended_with: string | null;
}

/** Scénario indexé pour lookup O(1) — produit par compile(). */
export interface CompiledScenario {
	external_id: string;
	title: string;
	prologue: string;
	lang: string;
	rules: ScenarioRules;
	characters: CharacterFixture[];
	evidences: EvidenceFixture[];
	state_axes: StateAxisFixture[];
	nodes: NodeFixture[];
	ends: EndFixture[];
	nodesById: Map<string, NodeFixture>;
	endsById: Map<string, EndFixture>;
	startNode: NodeFixture | null;
}

/** Input d'un tour de jeu (cf. design doc §7.2). */
export interface PlayerInput {
	/** Texte brut saisi par le joueur (rendu tel quel — pas évalué par le moteur). */
	text?: string;
	/** Label d'intention déjà classifié (en prod : retour d'/api/classify). */
	intent?: string;
	/** Label de classification CONFORME/NON_CONFORME/CRITIQUE/NON_COOPERATIF/etc. */
	classification?: string;
	/** Cible (PNJ) explicite — généralement déduite de l'UI ou de l'intention. */
	target?: string;
}

/** Déclaration d'intent côté fixture YAML (Node.intents — cf. §3.2 / §10.2). */
export interface IntentDecl {
	label: string;
	description: string;
}

/**
 * Résultat d'un appel de classifier (stub TS ou Go word2vec en Phase 6).
 * `classification` est posée uniquement si le label matché appartient à la taxonomie
 * connue (CONFORME / NON_CONFORME / CRITIQUE / NON_COOPERATIF / ...).
 */
export interface ClassifyResult {
	intent: string;
	classification?: string;
	confidence: number;
}

/** Résultat d'un tour de jeu. */
export interface StepResult {
	state: SessionState;
	next_node: NodeFixture | null;
	end: EndFixture | null;
	/** True si aucun candidat ne matchait ⇒ fallback ou rien. */
	fell_back: boolean;
}

/** État initial d'une session scripted (cf. §7.1). */
export function initialState(scn: CompiledScenario): SessionState {
	return {
		current_node: scn.startNode ? scn.startNode.external_id : null,
		visited_nodes: scn.startNode ? [scn.startNode.external_id] : [],
		evidences: [],
		scores: {},
		warnings: 0,
		actions_left: scn.rules.initial_actions ?? null,
		last_intent: null,
		last_classification: null,
		ended_with: null
	};
}
