// Validation référentielle d'un CompiledScenario : vérifie que toutes les
// références par external_id dans les conditions, effets et règles pointent vers
// une entité déclarée (node / evidence / character / state axis / end).
//
// Ni le schéma Zod (`scripted-scenario.schema.ts`) ni `compile()` ne font cette
// vérification croisée : ils valident respectivement la syntaxe et l'unicité
// des external_id, mais pas la cohérence référentielle. Cette fonction comble
// le trou — appelée par la route d'import avant la persistance, elle évite
// d'écrire un scenario incohérent en BD.

import type {
	CompiledScenario,
	Condition,
	Effect,
	EndFixture,
	NodeFixture
} from '$lib/narrative';

export type RefKind =
	| 'node'
	| 'evidence'
	| 'character'
	| 'state_axis'
	| 'end';

export interface RefValidationIssue {
	/** Chemin lisible (ex: `nodes[N2.5].condition.has`, `ends[FIN_REUSSITE].condition.visited[0]`). */
	path: string;
	/** L'external_id manquant. */
	ref: string;
	/** Type de l'entité cherchée. */
	kind: RefKind;
}

export function validateReferences(compiled: CompiledScenario): RefValidationIssue[] {
	const issues: RefValidationIssue[] = [];

	const nodeIds = new Set(compiled.nodes.map((n) => n.external_id));
	const evidenceIds = new Set(compiled.evidences.map((e) => e.external_id));
	const characterIds = new Set(compiled.characters.map((c) => c.external_id));
	const axisIds = new Set(compiled.state_axes.map((a) => a.external_id));
	const endIds = new Set(compiled.ends.map((e) => e.external_id));

	const check = (
		set: Set<string>,
		kind: RefKind,
		ref: string,
		path: string
	): void => {
		if (!set.has(ref)) issues.push({ path, ref, kind });
	};

	const walkCondition = (cond: Condition | undefined, path: string): void => {
		if (!cond) return;

		if (cond.all) cond.all.forEach((c, i) => walkCondition(c, `${path}.all[${i}]`));
		if (cond.any) cond.any.forEach((c, i) => walkCondition(c, `${path}.any[${i}]`));
		if (cond.not) walkCondition(cond.not, `${path}.not`);

		if (cond.from !== undefined) check(nodeIds, 'node', cond.from, `${path}.from`);
		if (cond.after !== undefined) check(nodeIds, 'node', cond.after, `${path}.after`);
		if (cond.last) cond.last.forEach((id, i) => check(nodeIds, 'node', id, `${path}.last[${i}]`));
		if (cond.visited) cond.visited.forEach((id, i) => check(nodeIds, 'node', id, `${path}.visited[${i}]`));

		if (cond.target !== undefined) check(characterIds, 'character', cond.target, `${path}.target`);

		if (cond.has !== undefined) check(evidenceIds, 'evidence', cond.has, `${path}.has`);
		if (cond.has_any) cond.has_any.forEach((id, i) => check(evidenceIds, 'evidence', id, `${path}.has_any[${i}]`));
		if (cond.has_all) cond.has_all.forEach((id, i) => check(evidenceIds, 'evidence', id, `${path}.has_all[${i}]`));
		if (cond.has_count_among) {
			cond.has_count_among.ids.forEach((id, i) =>
				check(evidenceIds, 'evidence', id, `${path}.has_count_among.ids[${i}]`)
			);
		}

		if (cond.score) check(axisIds, 'state_axis', cond.score.axis, `${path}.score.axis`);
		if (cond.score_level) check(axisIds, 'state_axis', cond.score_level.axis, `${path}.score_level.axis`);
	};

	const walkEffect = (eff: Effect, path: string): void => {
		if ('unlock' in eff) check(evidenceIds, 'evidence', eff.unlock, `${path}.unlock`);
		else if ('score' in eff) check(axisIds, 'state_axis', eff.score.axis, `${path}.score.axis`);
		else if ('end' in eff) check(endIds, 'end', eff.end, `${path}.end`);
	};

	for (const node of compiled.nodes) {
		walkCondition(node.condition, `nodes[${node.external_id}].condition`);
		(node.effects ?? []).forEach((eff: Effect, i: number) =>
			walkEffect(eff, `nodes[${node.external_id}].effects[${i}]`)
		);
	}

	for (const end of compiled.ends) {
		walkCondition(end.condition, `ends[${end.external_id}].condition`);
	}

	if (compiled.rules.fallback_node) {
		check(nodeIds, 'node', compiled.rules.fallback_node, 'rules.fallback_node');
	}
	if (compiled.rules.end_eval_after) {
		check(nodeIds, 'node', compiled.rules.end_eval_after, 'rules.end_eval_after');
	}

	return issues;
}

// Re-export pour les consommateurs qui veulent typer le retour.
export type { NodeFixture, EndFixture };
