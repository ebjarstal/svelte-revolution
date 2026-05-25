// Applicateur d'effets DSL (cf. design doc §5).
// Mute l'état passé en argument — utilisé uniquement après clonage par le moteur.

import type { Effect, SessionState } from './types';

export function applyEffect(effect: Effect, state: SessionState): void {
	if ('unlock' in effect) {
		if (!state.evidences.includes(effect.unlock)) state.evidences.push(effect.unlock);
		return;
	}
	if ('score' in effect) {
		const { axis, delta } = effect.score;
		state.scores[axis] = (state.scores[axis] ?? 0) + delta;
		return;
	}
	if ('warnings' in effect) {
		state.warnings += effect.warnings.delta;
		return;
	}
	if ('actions' in effect) {
		if (state.actions_left !== null) state.actions_left += effect.actions.delta;
		return;
	}
	if ('set_classification' in effect) {
		state.last_classification = effect.set_classification;
		return;
	}
	if ('end' in effect) {
		state.ended_with = effect.end;
		return;
	}
}
