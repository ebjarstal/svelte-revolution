import type { BaseNode } from '$types/graph';

export type NodeType = 'contribution' | 'event' | 'startNode' | 'hidden'; // hidden is not in the database
export type Lang = 'fr' | 'en' | 'jp';
export type Role = 'admin' | 'user' | 'superAdmin'; // see in the database

export interface GraphNode extends BaseNode {
	author: string;
	session: string;
	type: NodeType;
	parent: string;
	side: string | null;
	sideNumber: number;
	expand?: {
		side?: Side;
	};
	audio?: File | string | null // File when we send, string (url) when in db
	// scripted engine — additifs nullables pour ne pas casser l'usage free
	scenario?: string | null;
	external_id?: string;
	is_start?: boolean;
	consumes_action?: boolean;
	prompt_ia?: string;
	intents?: Array<{ label: string; description: string }>;
	condition?: unknown;
	effects?: unknown;
}

export type PreviewNode = Pick<GraphNode, 'id' | 'title' | 'text' | 'type' | 'side' | 'sideNumber' | 'parent'>;

export type ScenarioEngine = 'free' | 'scripted';

export interface Scenario {
	id: string;
	title: string;
	prologue: string;
	lang: Lang;
	ai?: boolean;
	firstNodeTitle: string;
	firstNodeText: string;
	firstNodeAuthor: string;
	// scripted engine (cf. docs/narrative-engine-design.md §3.2)
	engine?: ScenarioEngine;
	rules?: ScenarioRules | null;
	characters?: string[];   // relation N→N vers Characters
	evidences?: string[];    // relation N→N vers Evidences
	state_axes?: string[];   // relation N→N vers StateAxes
}

/** Paramètres globaux du moteur scripted pour un scénario. */
export interface ScenarioRules {
	initial_actions?: number | null;
	score_caps?: Record<string, number>;
	score_thresholds?: { faible: string; moyen: string; eleve: string };
	fallback_node?: string | null;
	end_eval_after?: string | null;
}

export interface End {
	id: string;
	title: string;
	text: string;
	// scripted engine
	external_id?: string;
	condition?: unknown;   // DSL §4, validé via scripted-scenario.schema
	priority?: number;
}

// ─── Collections scripted (cf. docs/narrative-engine-design.md §3.3) ───

export interface Character {
	id: string;
	scenario: string;
	external_id: string;
	name: string;
	role?: string;
	bio?: string;
}

export interface Evidence {
	id: string;
	scenario: string;
	external_id: string;
	label: string;
	description?: string;
}

export interface StateAxis {
	id: string;
	scenario: string;
	external_id: string;
	label: string;
	description?: string;
}

export interface GraphEvent {
	id: string;
	title: string;
	text: string;
	author: string;
}

export interface Session {
	id: string;
	slug: number;
	name: string;
	image: string;
	completed: boolean;
	visible: boolean;
	public: boolean;
	scenario: string;
	events: string[];
	author: string;
	end?: string;
	useAudio: boolean;
	created: Date;
	// scripted engine state (cf. docs/narrative-engine-design.md §3.2 / §7.1)
	current_node?: string | null;
	visited_nodes?: string[];
	evidences?: string[];
	scores?: Record<string, number>;
	warnings?: number;
	actions_left?: number | null;
	last_intent?: string;
	last_classification?: string;
	expand?: {
		scenario?: Scenario;
		end?: End;
		events?: GraphEvent[];
		author?: User;
	};
}

export interface Side {
	id: string;
	name: string;
	number: number;
	icon?: string;
}

export interface User {
	id: string;
	username: string;
	role: Role;
	email?: string;
	name?: string;
	avatar?: string;
}
