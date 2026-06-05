import * as values from '$lib/mainGraph/values';
import { buildScenarioGraph, type ScenarioGraphEdge } from '$lib/scenario/graphModel';
import Graph, { defaultGraphOptions, type GraphOptions } from './Graph.svelte';
import type { SimulationLinkDatum } from 'd3';
import type { BaseNode } from '$types/graph';
import type { CompiledScript } from '$lib/scenario/compile';
import type { ScenarioNodeKind, ScenarioEdgeKind } from '$lib/scenario/graphModel';

// d3 datum for a scenario node: the pure model node + the fields the base Graph/layout need.
export type ScriptGraphNode = BaseNode & { kind: ScenarioNodeKind };

type ScriptLink = SimulationLinkDatum<ScriptGraphNode> & {
	source: ScriptGraphNode;
	target: ScriptGraphNode;
	kind: ScenarioEdgeKind;
};

// kind → the base layout `type` (drives link distance + centering forces in Graph).
const layoutType: Record<ScenarioNodeKind, string> = {
	start: 'startNode',
	node: 'contribution',
	ending: 'event',
	global: 'event'
};

// Distinct fills per node kind (literals: this view is not part of the in-session palette).
const kindFill: Record<ScenarioNodeKind, string> = {
	start: values.graphColors.nodes.start, // red
	node: values.graphColors.nodes.sides[0], // green
	ending: '#7ab8ff', // blue
	global: '#c89bf5' // purple
};

// kind → glyph (values.graphIcons order: [triangle, diamond, square, hexagon, circle]).
const kindIcon: Record<ScenarioNodeKind, string> = {
	start: values.graphIcons[0], // triangle
	node: values.graphIcons[4], // circle
	ending: values.graphIcons[1], // diamond
	global: values.graphIcons[3] // hexagon
};

export class ScriptGraph extends Graph<ScriptGraphNode, ScriptLink> {
	#edges: ScenarioGraphEdge[];

	constructor(svg: SVGElement, script: CompiledScript, options: Partial<GraphOptions> = defaultGraphOptions) {
		const model = buildScenarioGraph(script);
		const nodes: ScriptGraphNode[] = model.nodes.map((n) => ({
			id: n.id,
			title: n.title,
			text: n.text,
			kind: n.kind,
			type: layoutType[n.kind]
		}));
		super(svg, nodes, options);
		this.#edges = model.edges;
		this._nodes = nodes;
		$effect(() => {
			this.init();
		});
	}

	// DAG links: build from the explicit edge list, not the (unused) parent pointer.
	protected _buildLinks(nodes: ScriptGraphNode[]): ScriptLink[] {
		const byId: Record<string, ScriptGraphNode> = {};
		for (const n of nodes) byId[String(n.id)] = n;
		const links: ScriptLink[] = [];
		for (const e of this.#edges) {
			const source = byId[e.source];
			const target = byId[e.target];
			if (source && target) links.push({ source, target, kind: e.kind });
		}
		return links;
	}

	getNodeIcon = (node: ScriptGraphNode) => kindIcon[node.kind];
	getNodeFill = (node: ScriptGraphNode) => {
		if (this.selectedNode && this.selectedNode.id === node.id) {
			return values.graphColors.nodes.selected;
		}
		return kindFill[node.kind];
	};
	getNodeStroke = (_node: ScriptGraphNode) => 'transparent';
	getLinkStroke = (l: ScriptLink) =>
		l.kind === 'global' ? values.graphColors.links.toHide : values.graphColors.links.default;
	getNodeRadius = (d: ScriptGraphNode) => {
		if (this.selectedNode && this.selectedNode.id === d.id) return values.nodeRadius.selected;
		if (d.kind === 'start') return values.nodeRadius.start;
		if (d.kind === 'ending' || d.kind === 'global') return values.nodeRadius.event;
		return values.nodeRadius.default;
	};
	getNodeScale = (d: ScriptGraphNode) => {
		const selected = this.selectedNode?.id === d.id;
		if (d.kind === 'start') {
			return selected ? values.nodeScale.start.selected : values.nodeScale.start.default;
		}
		if (d.kind === 'ending' || d.kind === 'global') {
			return selected ? values.nodeScale.event.selected : values.nodeScale.event.default;
		}
		return selected ? values.nodeScale.default.selected : values.nodeScale.default.default;
	};
}
