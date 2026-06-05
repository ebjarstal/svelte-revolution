// Derives a directed-graph model (nodes + edges) from a compiled gamemaster script, for the
// admin scenario visualisation. Pure and d3-free so it can be unit-tested; ScriptGraph adapts
// the output into d3 datums.
//
// A scenario is a DAG, not a tree: authored nodes fan in (several nodes route to the same hub),
// decisions fan out, and the `global` decision is reachable "from anywhere". To keep the picture
// readable, the global decision is rendered as ONE synthetic hub node (GLOBAL_NODE_ID) with an
// edge to each of its targets, rather than an edge from every node.

import type { CompiledScript } from './compile';
import type { Decision } from './script.schema';

export type ScenarioNodeKind = 'start' | 'node' | 'ending' | 'global';
export type ScenarioEdgeKind = 'goto' | 'decision' | 'ending' | 'global';

export const GLOBAL_NODE_ID = '__global__';

export type ScenarioGraphNode = {
	id: string;
	title: string;
	text: string;
	kind: ScenarioNodeKind;
};

export type ScenarioGraphEdge = {
	source: string;
	target: string;
	kind: ScenarioEdgeKind;
};

export type ScenarioGraphModel = {
	nodes: ScenarioGraphNode[];
	edges: ScenarioGraphEdge[];
};

export function buildScenarioGraph(script: CompiledScript): ScenarioGraphModel {
	const nodes: ScenarioGraphNode[] = [];
	const seenNode = new Set<string>();
	const pushNode = (n: ScenarioGraphNode) => {
		if (seenNode.has(n.id)) return;
		seenNode.add(n.id);
		nodes.push(n);
	};

	for (const n of script.nodes) {
		pushNode({
			id: n.id,
			title: n.title ?? n.id,
			text: n.text,
			kind: n.id === 'start' ? 'start' : 'node'
		});
	}
	for (const e of script.endings) {
		pushNode({ id: e.id, title: e.title ?? e.id, text: e.text, kind: 'ending' });
	}

	const edges: ScenarioGraphEdge[] = [];
	const seenEdge = new Set<string>();
	const pushEdge = (source: string, target: string, kind: ScenarioEdgeKind) => {
		// Collapse parallel transitions (same source→target, e.g. several `when` clauses) into one
		// arrow per kind so the graph stays legible.
		const key = `${source}->${target}:${kind}`;
		if (seenEdge.has(key)) return;
		seenEdge.add(key);
		edges.push({ source, target, kind });
	};

	const resolveDecision = (d: string | Decision): Decision | undefined =>
		typeof d === 'string' ? script.decisions[d] : d;

	for (const n of script.nodes) {
		if (n.goto) pushEdge(n.id, n.goto, 'goto');
		if (n.ending) pushEdge(n.id, n.ending, 'ending');
		if (n.decision) {
			const dec = resolveDecision(n.decision);
			if (dec) for (const t of dec.transitions) pushEdge(n.id, t.to, 'decision');
		}
	}

	if (script.global) {
		pushNode({ id: GLOBAL_NODE_ID, title: '⟳ global', text: '', kind: 'global' });
		for (const t of script.global.decision.transitions) {
			pushEdge(GLOBAL_NODE_ID, t.to, 'global');
		}
	}

	return { nodes, edges };
}
