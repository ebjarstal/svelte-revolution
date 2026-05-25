// Moteur de tour d'une session scripted (cf. design doc §7.2).
// Pur : pas d'IO, pas de DB, pas de réseau. Tout ce dont il a besoin lui est passé en argument.

import type {
	CompiledScenario,
	NodeFixture,
	PlayerInput,
	SessionState,
	StepResult
} from './types';
import { evaluate, type EvalContext } from './conditions';
import { applyEffect } from './effects';

export function step(
	scenario: CompiledScenario,
	state: SessionState,
	input: PlayerInput
): StepResult {
	if (state.ended_with !== null) {
		// Session déjà terminée — no-op.
		return {
			state,
			next_node: null,
			end: scenario.endsById.get(state.ended_with) ?? null,
			fell_back: false
		};
	}

	const ctx: EvalContext = {
		state,
		intent: input.intent ?? null,
		classification: input.classification ?? null,
		target: input.target ?? null,
		rules: scenario.rules
	};

	// Candidats : tous les noeuds (1) non-start (2) avec une `condition` définie (3) dont la
	// condition matche. Les noeuds sans condition sont réservés au fallback (cf. §7.3) ou aux
	// noeuds is_start.
	const candidates: { node: NodeFixture; specificity: number; order: number }[] = [];
	for (let i = 0; i < scenario.nodes.length; i++) {
		const node = scenario.nodes[i];
		if (node.is_start) continue;
		if (node.condition === undefined) continue;
		const r = evaluate(node.condition, ctx);
		if (r.ok) candidates.push({ node, specificity: r.matched, order: i });
	}
	// Tri : spécificité décroissante, puis ordre d'apparition YAML (déterministe).
	candidates.sort((a, b) => b.specificity - a.specificity || a.order - b.order);

	let chosen: NodeFixture | null = null;
	let fellBack = false;

	if (candidates.length > 0) {
		chosen = candidates[0].node;
	} else {
		const fallbackId = scenario.rules.fallback_node ?? null;
		if (fallbackId) chosen = scenario.nodesById.get(fallbackId) ?? null;
		fellBack = true;
	}

	const next = cloneState(state);
	next.last_intent = input.intent ?? null;
	next.last_classification = input.classification ?? null;

	if (chosen) {
		// Le fallback est un rendu UI uniquement — il NE doit PAS faire avancer l'état
		// canonique (sinon `current_node` devient le fallback, et tous les noeuds qui
		// dépendent de `last: [N_précédent]` deviennent inatteignables → cul-de-sac).
		// Le caller récupère le fallbackNode via `next_node` pour rendre son texte.
		if (!fellBack) {
			next.current_node = chosen.external_id;
			if (!next.visited_nodes.includes(chosen.external_id)) {
				next.visited_nodes.push(chosen.external_id);
			}
			for (const effect of chosen.effects ?? []) applyEffect(effect, next);
			if (chosen.consumes_action !== false && next.actions_left !== null) {
				next.actions_left = Math.max(0, next.actions_left - 1);
			}
		}
	}

	// Évaluation des fins (sauf si déjà terminé par un effet `end:` du noeud choisi).
	if (next.ended_with === null) {
		const gate = scenario.rules.end_eval_after ?? null;
		const gateOk = gate === null || next.visited_nodes.includes(gate);
		if (gateOk) {
			const endCtx: EvalContext = {
				state: next,
				intent: input.intent ?? null,
				classification: input.classification ?? null,
				target: input.target ?? null,
				rules: scenario.rules
			};
			const sorted = [...scenario.ends].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
			for (const end of sorted) {
				if (!end.condition) continue;
				const r = evaluate(end.condition, endCtx);
				if (r.ok) {
					next.ended_with = end.external_id;
					break;
				}
			}
		}
	}

	const endRec = next.ended_with ? scenario.endsById.get(next.ended_with) ?? null : null;
	return { state: next, next_node: chosen, end: endRec, fell_back: fellBack };
}

function cloneState(s: SessionState): SessionState {
	return {
		current_node: s.current_node,
		visited_nodes: [...s.visited_nodes],
		evidences: [...s.evidences],
		scores: { ...s.scores },
		warnings: s.warnings,
		actions_left: s.actions_left,
		last_intent: s.last_intent,
		last_classification: s.last_classification,
		ended_with: s.ended_with
	};
}
