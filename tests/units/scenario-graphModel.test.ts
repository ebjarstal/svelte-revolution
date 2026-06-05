import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileScenario } from '../../src/lib/scenario/compile';
import { buildScenarioGraph, GLOBAL_NODE_ID } from '../../src/lib/scenario/graphModel';

const read = (name: string) =>
	readFileSync(new URL(`../../scenarios/${name}`, import.meta.url), 'utf-8');

describe('buildScenarioGraph', () => {
	it('models 3036 as a DAG with fan-in and no global hub', () => {
		const script = compileScenario(read('3036.yaml'));
		const { nodes, edges } = buildScenarioGraph(script);

		// start node + endings are represented
		expect(nodes.find((n) => n.id === 'start')?.kind).toBe('start');
		for (const e of script.endings) {
			expect(nodes.find((n) => n.id === e.id)?.kind).toBe('ending');
		}

		// no global decision in 3036 → no synthetic hub
		expect(nodes.some((n) => n.id === GLOBAL_NODE_ID)).toBe(false);
		expect(edges.some((e) => e.kind === 'global')).toBe(false);

		// every edge endpoint resolves to a node (faithful, no dangling arrows)
		const ids = new Set(nodes.map((n) => n.id));
		for (const e of edges) {
			expect(ids.has(e.source), `source ${e.source}`).toBe(true);
			expect(ids.has(e.target), `target ${e.target}`).toBe(true);
		}

		// fan-in: at least one node is reached from ≥2 distinct sources (a convergence the
		// parent-based tree model could not represent)
		const indegree = new Map<string, Set<string>>();
		for (const e of edges) {
			if (!indegree.has(e.target)) indegree.set(e.target, new Set());
			indegree.get(e.target)!.add(e.source);
		}
		expect([...indegree.values()].some((sources) => sources.size >= 2)).toBe(true);
	});

	it('models helix with a global hub linked to its targets', () => {
		const script = compileScenario(read('helix.yaml'));
		const { nodes, edges } = buildScenarioGraph(script);

		const hub = nodes.find((n) => n.id === GLOBAL_NODE_ID);
		expect(hub?.kind).toBe('global');

		// one global edge per distinct target (parallel transitions to the same node collapse)
		const globalEdges = edges.filter((e) => e.kind === 'global');
		const distinctTargets = new Set(script.global!.decision.transitions.map((t) => t.to));
		expect(globalEdges.length).toBe(distinctTargets.size);
		expect(globalEdges.every((e) => e.source === GLOBAL_NODE_ID)).toBe(true);

		// all endpoints resolve
		const ids = new Set(nodes.map((n) => n.id));
		for (const e of edges) {
			expect(ids.has(e.source)).toBe(true);
			expect(ids.has(e.target)).toBe(true);
		}
	});
});
