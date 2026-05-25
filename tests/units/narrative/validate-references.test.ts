import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { compile, parseYaml } from '../../../src/lib/narrative';
import { scriptedScenarioSchema } from '../../../src/lib/zschemas/scripted-scenario.schema';
import { validateReferences } from '../../../src/lib/scenario/validate-references';

function loadCompiled(name: string) {
	const path = resolve(__dirname, '../../../scenarios/fixtures', name);
	const raw = parseYaml(readFileSync(path, 'utf-8'));
	const parsed = scriptedScenarioSchema.parse(raw);
	return compile(parsed);
}

describe('validateReferences', () => {
	test('helix-corp.yaml passe (toutes références résolues)', () => {
		const compiled = loadCompiled('helix-corp.yaml');
		expect(validateReferences(compiled)).toEqual([]);
	});

	test('3036.yaml passe (toutes références résolues)', () => {
		const compiled = loadCompiled('3036.yaml');
		expect(validateReferences(compiled)).toEqual([]);
	});

	test('détecte une evidence inexistante dans condition.has', () => {
		const compiled = loadCompiled('helix-corp.yaml');
		const node = compiled.nodes[1]!;
		node.condition = { has: 'P_FANTOME' };

		const issues = validateReferences(compiled);
		const refIssue = issues.find((i) => i.ref === 'P_FANTOME');
		expect(refIssue).toBeDefined();
		expect(refIssue?.kind).toBe('evidence');
		expect(refIssue?.path).toBe(`nodes[${node.external_id}].condition.has`);
	});

	test('détecte un node inexistant dans condition.visited (fin)', () => {
		const compiled = loadCompiled('helix-corp.yaml');
		const end = compiled.ends[0]!;
		end.condition = { visited: ['N_FANTOME'] };

		const issues = validateReferences(compiled);
		const refIssue = issues.find((i) => i.ref === 'N_FANTOME');
		expect(refIssue).toBeDefined();
		expect(refIssue?.kind).toBe('node');
		expect(refIssue?.path).toBe(`ends[${end.external_id}].condition.visited[0]`);
	});

	test('détecte un state_axis inexistant dans effects[].score', () => {
		const compiled = loadCompiled('3036.yaml');
		const node = compiled.nodes.find((n) =>
			(n.effects ?? []).some((e) => 'score' in e)
		);
		if (!node) throw new Error('aucun noeud avec effects.score dans la fixture');
		node.effects = (node.effects ?? []).map((e) =>
			'score' in e ? { score: { axis: 'AXE_FANTOME', delta: e.score.delta } } : e
		);

		const issues = validateReferences(compiled);
		const refIssue = issues.find((i) => i.ref === 'AXE_FANTOME');
		expect(refIssue).toBeDefined();
		expect(refIssue?.kind).toBe('state_axis');
	});

	test('détecte un node inexistant dans rules.fallback_node', () => {
		const compiled = loadCompiled('helix-corp.yaml');
		compiled.rules = { ...compiled.rules, fallback_node: 'NF_FANTOME' };

		const issues = validateReferences(compiled);
		const refIssue = issues.find((i) => i.ref === 'NF_FANTOME');
		expect(refIssue).toBeDefined();
		expect(refIssue?.kind).toBe('node');
		expect(refIssue?.path).toBe('rules.fallback_node');
	});

	test('descend récursivement dans all/any/not', () => {
		const compiled = loadCompiled('helix-corp.yaml');
		const node = compiled.nodes[1]!;
		node.condition = {
			all: [
				{ any: [{ has: 'P_FANTOME_NESTED' }] }
			]
		};

		const issues = validateReferences(compiled);
		const refIssue = issues.find((i) => i.ref === 'P_FANTOME_NESTED');
		expect(refIssue).toBeDefined();
		expect(refIssue?.path).toContain('.all[0].any[0].has');
	});

	// ── Couverture systématique : un cas par type de référence (Fix 5) ──────────
	// Le moteur pur ne fait pas cette validation : c'est validateReferences (vivant
	// dans src/lib/scenario/, hors hermeticité du moteur) qui sert de filet aux
	// fixtures malformées. Régression cross-module : on s'assure ici que les 4
	// types de référence sont systématiquement couverts.
	describe('couverture par type de référence', () => {
		test('node fantôme dans condition.from', () => {
			const compiled = loadCompiled('helix-corp.yaml');
			const node = compiled.nodes[2]!;
			node.condition = { from: 'N_INEXISTANT' };
			const issues = validateReferences(compiled);
			const found = issues.find((i) => i.ref === 'N_INEXISTANT');
			expect(found).toBeDefined();
			expect(found?.kind).toBe('node');
		});

		test('evidence fantôme dans effects.unlock', () => {
			const compiled = loadCompiled('helix-corp.yaml');
			const node = compiled.nodes[2]!;
			node.effects = [{ unlock: 'P_FANTOME' }];
			const issues = validateReferences(compiled);
			const found = issues.find((i) => i.ref === 'P_FANTOME');
			expect(found).toBeDefined();
			expect(found?.kind).toBe('evidence');
		});

		test('character fantôme dans condition.target', () => {
			const compiled = loadCompiled('helix-corp.yaml');
			const node = compiled.nodes[2]!;
			node.condition = { target: 'pnj_inexistant' };
			const issues = validateReferences(compiled);
			const found = issues.find((i) => i.ref === 'pnj_inexistant');
			expect(found).toBeDefined();
			expect(found?.kind).toBe('character');
		});

		test('end fantôme dans effects.end', () => {
			const compiled = loadCompiled('helix-corp.yaml');
			const node = compiled.nodes[2]!;
			node.effects = [{ end: 'FIN_FANTOME' }];
			const issues = validateReferences(compiled);
			const found = issues.find((i) => i.ref === 'FIN_FANTOME');
			expect(found).toBeDefined();
			expect(found?.kind).toBe('end');
		});
	});
});
