import type { BaseNode } from '$types/graph';
import type { CompiledScript } from '$lib/scenario/compile';
import type { RuntimeState } from '$lib/server/gamemaster/engine';

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
}

export type PreviewNode = Pick<GraphNode, 'id' | 'title' | 'text' | 'type' | 'side' | 'sideNumber' | 'parent'>;

export interface Scenario {
	id: string;
	title: string;
	prologue: string;
	lang: Lang;
	ai?: boolean;
	firstNodeTitle: string;
	firstNodeText: string;
	firstNodeAuthor: string;
	engine?: 'legacy' | 'gamemaster'; // empty/undefined ⇒ legacy
	script?: CompiledScript | null; // compiled gamemaster script; null for legacy scenarios
	sourceYaml?: string; // raw uploaded YAML, kept so post-upload edits can be diffed against the original
}

export interface End {
	id: string;
	title: string;
	text: string;
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
	state?: RuntimeState | null; // per-session gamemaster runtime; null for legacy sessions
	created: Date;
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
