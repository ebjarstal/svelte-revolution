// Évaluateur des conditions DSL (cf. design doc §4) avec calcul de spécificité.
//
// La spécificité représente le « nombre de prédicats matchés » utilisé pour départager
// plusieurs noeuds candidats (cf. §7.2 étape 8). Règles :
//   - Un prédicat feuille vrai compte 1.
//   - `all` : somme des spécificités des enfants (et tous doivent être vrais).
//   - `any` : spécificité de la branche gagnante (et au moins un enfant doit être vrai).
//   - `not` : 1 si l'enfant est faux.
//   - Sac de prédicats au top-level d'un objet : implicitement `all`.

import type { Condition, ScenarioRules, SessionState } from './types';

export interface EvalContext {
	state: SessionState;
	intent: string | null;
	classification: string | null;
	target: string | null;
	rules: ScenarioRules;
}

export interface EvalResult {
	ok: boolean;
	matched: number;
}

const FAIL: EvalResult = { ok: false, matched: 0 };

export function evaluate(cond: Condition | undefined | null, ctx: EvalContext): EvalResult {
	if (cond === undefined || cond === null) return { ok: true, matched: 0 };
	const branches: EvalResult[] = [];

	// Prédicats topologie
	if (cond.from !== undefined) branches.push(checkVisitedSingle(cond.from, ctx));
	if (cond.after !== undefined) branches.push(checkVisitedSingle(cond.after, ctx));
	if (cond.last !== undefined) branches.push(checkLast(cond.last, ctx));
	if (cond.visited !== undefined) branches.push(checkVisitedAll(cond.visited, ctx));

	// Prédicats intent / target / classification
	if (cond.intent_in !== undefined) branches.push(checkIntentIn(cond.intent_in, ctx));
	if (cond.target !== undefined) branches.push(checkTarget(cond.target, ctx));
	if (cond.classification_is !== undefined) branches.push(checkClassification(cond.classification_is, ctx));

	// Prédicats preuves
	if (cond.has !== undefined) branches.push(checkHas(cond.has, ctx));
	if (cond.has_any !== undefined) branches.push(checkHasAny(cond.has_any, ctx));
	if (cond.has_all !== undefined) branches.push(checkHasAll(cond.has_all, ctx));
	if (cond.has_count_gte !== undefined) branches.push(checkHasCountGte(cond.has_count_gte, ctx));
	if (cond.has_count_among !== undefined) branches.push(checkHasCountAmong(cond.has_count_among, ctx));

	// Prédicats score / actions / warnings
	if (cond.score !== undefined) branches.push(checkScore(cond.score, ctx));
	if (cond.score_level !== undefined) branches.push(checkScoreLevel(cond.score_level, ctx));
	if (cond.actions_left !== undefined) branches.push(checkActionsLeft(cond.actions_left, ctx));
	if (cond.warnings !== undefined) branches.push(checkWarnings(cond.warnings, ctx));

	// Combinateurs
	if (cond.all !== undefined) branches.push(checkAll(cond.all, ctx));
	if (cond.any !== undefined) branches.push(checkAny(cond.any, ctx));
	if (cond.not !== undefined) branches.push(checkNot(cond.not, ctx));

	if (branches.length === 0) return { ok: true, matched: 0 };

	let matched = 0;
	for (const b of branches) {
		if (!b.ok) return FAIL;
		matched += b.matched;
	}
	return { ok: true, matched };
}

// ─── Topologie ──────────────────────────────────────────────────────────────

function checkVisitedSingle(id: string, ctx: EvalContext): EvalResult {
	return ctx.state.visited_nodes.includes(id) ? { ok: true, matched: 1 } : FAIL;
}

function checkLast(ids: string[], ctx: EvalContext): EvalResult {
	if (ctx.state.current_node === null) return FAIL;
	return ids.includes(ctx.state.current_node) ? { ok: true, matched: 1 } : FAIL;
}

function checkVisitedAll(ids: string[], ctx: EvalContext): EvalResult {
	for (const id of ids) {
		if (!ctx.state.visited_nodes.includes(id)) return FAIL;
	}
	return { ok: true, matched: 1 };
}

// ─── Intent / target / classification ───────────────────────────────────────

function checkIntentIn(labels: string[], ctx: EvalContext): EvalResult {
	if (ctx.intent === null) return FAIL;
	return labels.includes(ctx.intent) ? { ok: true, matched: 1 } : FAIL;
}

function checkTarget(characterId: string, ctx: EvalContext): EvalResult {
	if (ctx.target === null) return FAIL;
	return ctx.target === characterId ? { ok: true, matched: 1 } : FAIL;
}

function checkClassification(label: string, ctx: EvalContext): EvalResult {
	if (ctx.classification === null) return FAIL;
	return ctx.classification === label ? { ok: true, matched: 1 } : FAIL;
}

// ─── Preuves ────────────────────────────────────────────────────────────────

function checkHas(id: string, ctx: EvalContext): EvalResult {
	return ctx.state.evidences.includes(id) ? { ok: true, matched: 1 } : FAIL;
}

function checkHasAny(ids: string[], ctx: EvalContext): EvalResult {
	for (const id of ids) if (ctx.state.evidences.includes(id)) return { ok: true, matched: 1 };
	return FAIL;
}

function checkHasAll(ids: string[], ctx: EvalContext): EvalResult {
	for (const id of ids) if (!ctx.state.evidences.includes(id)) return FAIL;
	return { ok: true, matched: 1 };
}

function checkHasCountGte(n: number, ctx: EvalContext): EvalResult {
	return ctx.state.evidences.length >= n ? { ok: true, matched: 1 } : FAIL;
}

function checkHasCountAmong(
	pred: { ids: string[]; gte?: number; lte?: number },
	ctx: EvalContext
): EvalResult {
	let count = 0;
	for (const id of pred.ids) if (ctx.state.evidences.includes(id)) count++;
	if (pred.gte !== undefined && count < pred.gte) return FAIL;
	if (pred.lte !== undefined && count > pred.lte) return FAIL;
	if (pred.gte === undefined && pred.lte === undefined) return FAIL;
	return { ok: true, matched: 1 };
}

// ─── Score / actions / warnings ─────────────────────────────────────────────

function checkScore(
	pred: { axis: string; gte?: number; lte?: number; eq?: number },
	ctx: EvalContext
): EvalResult {
	const v = ctx.state.scores[pred.axis] ?? 0;
	return compareTriple(v, pred);
}

function checkActionsLeft(
	pred: { gte?: number; lte?: number; eq?: number },
	ctx: EvalContext
): EvalResult {
	if (ctx.state.actions_left === null) return FAIL;
	return compareTriple(ctx.state.actions_left, pred);
}

function checkWarnings(
	pred: { gte?: number; lte?: number; eq?: number },
	ctx: EvalContext
): EvalResult {
	return compareTriple(ctx.state.warnings, pred);
}

function compareTriple(
	v: number,
	pred: { gte?: number; lte?: number; eq?: number }
): EvalResult {
	if (pred.eq !== undefined && v !== pred.eq) return FAIL;
	if (pred.gte !== undefined && v < pred.gte) return FAIL;
	if (pred.lte !== undefined && v > pred.lte) return FAIL;
	if (pred.eq === undefined && pred.gte === undefined && pred.lte === undefined) return FAIL;
	return { ok: true, matched: 1 };
}

// ─── Score level (palier faible/moyen/élevé) ────────────────────────────────
// Paliers calculés depuis score_caps via les seuils 33% / 66% (cf. §4.2 du design doc).

function checkScoreLevel(
	pred: { axis: string; level: 'faible' | 'moyen' | 'eleve' },
	ctx: EvalContext
): EvalResult {
	const caps = ctx.rules.score_caps ?? {};
	const cap = caps[pred.axis];
	if (cap === undefined || cap <= 0) {
		// Pas de cap configuré : on traite le score 0 comme 'faible' et tout > 0 comme indéterminé.
		const v = ctx.state.scores[pred.axis] ?? 0;
		if (pred.level === 'faible' && v === 0) return { ok: true, matched: 1 };
		return FAIL;
	}
	const v = ctx.state.scores[pred.axis] ?? 0;
	const ratio = v / cap;
	const isFaible = ratio < 0.33;
	const isEleve = ratio > 0.66;
	const isMoyen = !isFaible && !isEleve;
	const ok =
		(pred.level === 'faible' && isFaible) ||
		(pred.level === 'moyen' && isMoyen) ||
		(pred.level === 'eleve' && isEleve);
	return ok ? { ok: true, matched: 1 } : FAIL;
}

// ─── Combinateurs ───────────────────────────────────────────────────────────

function checkAll(children: Condition[], ctx: EvalContext): EvalResult {
	let matched = 0;
	for (const c of children) {
		const r = evaluate(c, ctx);
		if (!r.ok) return FAIL;
		matched += r.matched;
	}
	return { ok: true, matched };
}

function checkAny(children: Condition[], ctx: EvalContext): EvalResult {
	let best: EvalResult | null = null;
	for (const c of children) {
		const r = evaluate(c, ctx);
		if (r.ok && (best === null || r.matched > best.matched)) best = r;
	}
	return best ?? FAIL;
}

function checkNot(inner: Condition, ctx: EvalContext): EvalResult {
	const r = evaluate(inner, ctx);
	return r.ok ? FAIL : { ok: true, matched: 1 };
}
