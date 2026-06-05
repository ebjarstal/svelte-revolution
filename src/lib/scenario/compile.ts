// Compiles an LLM-gamemaster scenario YAML into a validated, integrity-checked script.
// See docs/llm-gamemaster-design.md §5. The pipeline is:
//   YAML text → parse → Zod scriptSchema → static integrity checks → compile classifier
//   JSON schemas. Any failure throws a ScenarioCompileError carrying clear, listed issues
//   so authoring errors surface at upload time, not at runtime.

import { parse, YAMLParseError } from 'yaml';
import {
	scriptSchema,
	type Script,
	type Classifier,
	type Decision,
	type Effects,
	type Predicate
} from './script.schema';

export class ScenarioCompileError extends Error {
	issues: string[];
	constructor(issues: string[]) {
		super(`Scenario compilation failed:\n- ${issues.join('\n- ')}`);
		this.name = 'ScenarioCompileError';
		this.issues = issues;
	}
}

// A Mistral-style strict JSON schema for one classifier's constrained output.
export type ClassifierJsonSchema = {
	type: 'object';
	properties: Record<string, unknown>;
	required: string[];
	additionalProperties: false;
};

export type CompiledScript = Script & {
	classifierSchemas: Record<string, ClassifierJsonSchema>;
};

export function compileScenario(yamlText: string): CompiledScript {
	// 1. parse YAML
	let raw: unknown;
	try {
		raw = parse(yamlText);
	} catch (e) {
		const msg = e instanceof YAMLParseError ? e.message : (e as Error).message;
		throw new ScenarioCompileError([`YAML parse error: ${msg}`]);
	}
	if (raw === null || typeof raw !== 'object') {
		throw new ScenarioCompileError(['YAML did not produce a scenario object.']);
	}

	// 2. structural validation
	const result = scriptSchema.safeParse(raw);
	if (!result.success) {
		const issues = result.error.issues.map(
			(i) => `${i.path.join('.') || '(root)'}: ${i.message}`
		);
		throw new ScenarioCompileError(issues);
	}
	const script = result.data;

	// 3. static integrity checks
	const issues = checkIntegrity(script);
	if (issues.length) throw new ScenarioCompileError(issues);

	// 4. compile per-classifier JSON schemas
	const classifierSchemas: Record<string, ClassifierJsonSchema> = {};
	for (const [id, classifier] of Object.entries(script.classifiers)) {
		classifierSchemas[id] = buildClassifierJsonSchema(classifier);
	}

	return { ...script, classifierSchemas };
}

// --- integrity checks ------------------------------------------------------

function flagNamesOf(flags: Script['state']['flags']): Set<string> {
	return new Set(Array.isArray(flags) ? flags : Object.keys(flags));
}

function checkIntegrity(script: Script): string[] {
	const issues: string[] = [];

	const nodeIds = new Set<string>();
	for (const n of script.nodes) {
		if (nodeIds.has(n.id)) issues.push(`Duplicate node id: '${n.id}'.`);
		nodeIds.add(n.id);
	}
	const endingIds = new Set<string>();
	for (const e of script.endings) {
		if (endingIds.has(e.id)) issues.push(`Duplicate ending id: '${e.id}'.`);
		endingIds.add(e.id);
	}

	const flagNames = flagNamesOf(script.state.flags);
	const varNames = new Set(Object.keys(script.state.vars));
	const counterNames = new Set(Object.keys(script.state.counters));
	const thresholdNames = new Set(Object.keys(script.state.thresholds));
	const classifierIds = new Set(Object.keys(script.classifiers));
	const decisionIds = new Set(Object.keys(script.decisions));

	if (!nodeIds.has('start')) issues.push(`Missing required 'start' node.`);

	const resolveTarget = (to: string, ctx: string) => {
		if (!nodeIds.has(to) && !endingIds.has(to)) {
			issues.push(`${ctx}: 'to: ${to}' resolves to no node or ending.`);
		}
	};

	const refs = { flagNames, varNames, counterNames, thresholdNames };

	const validateDecision = (dec: Decision, ctx: string) => {
		const classifier = script.classifiers[dec.classifier];
		if (!classifier) issues.push(`${ctx}: unknown classifier '${dec.classifier}'.`);
		dec.transitions.forEach((t, i) => {
			const tctx = `${ctx} transition[${i}]`;
			resolveTarget(t.to, tctx);
			if (t.when) validatePredicate(t.when, classifier, tctx, refs, issues);
			if (t.effects) validateEffects(t.effects, tctx, refs, issues);
		});
	};

	for (const [id, dec] of Object.entries(script.decisions)) {
		validateDecision(dec, `decision '${id}'`);
	}
	if (script.global) validateDecision(script.global.decision, 'global.decision');

	for (const n of script.nodes) {
		const ctx = `node '${n.id}'`;
		if (n.effects) validateEffects(n.effects, ctx, refs, issues);
		if (n.goto) resolveTarget(n.goto, `${ctx} goto`);
		if (n.ending && !endingIds.has(n.ending)) {
			issues.push(`${ctx}: ending '${n.ending}' does not exist.`);
		}
		if (n.consume) {
			for (const k of Object.keys(n.consume)) {
				if (!counterNames.has(k)) issues.push(`${ctx}: consume references unknown counter '${k}'.`);
			}
		}
		if (typeof n.decision === 'string') {
			if (!decisionIds.has(n.decision)) issues.push(`${ctx}: unknown decision '${n.decision}'.`);
		} else if (n.decision) {
			validateDecision(n.decision, `${ctx} inline decision`);
		}
	}

	for (const e of script.endings) {
		validatePredicate(e.when, undefined, `ending '${e.id}'`, refs, issues);
	}

	if (!hasReachableEnding(script, nodeIds, endingIds)) {
		issues.push(`No ending is reachable from the 'start' node.`);
	}

	return issues;
}

type Refs = {
	flagNames: Set<string>;
	varNames: Set<string>;
	counterNames: Set<string>;
	thresholdNames: Set<string>;
};

function validateEffects(effects: Effects, ctx: string, refs: Refs, issues: string[]) {
	for (const k of Object.keys(effects.vars ?? {})) {
		if (!refs.varNames.has(k)) issues.push(`${ctx}: effect sets unknown var '${k}'.`);
	}
	for (const k of Object.keys(effects.flags ?? {})) {
		if (!refs.flagNames.has(k)) issues.push(`${ctx}: effect sets unknown flag '${k}'.`);
	}
	for (const k of Object.keys(effects.counters ?? {})) {
		if (!refs.counterNames.has(k)) issues.push(`${ctx}: effect sets unknown counter '${k}'.`);
	}
}

function validatePredicate(
	pred: Predicate,
	classifier: Classifier | undefined,
	ctx: string,
	refs: Refs,
	issues: string[]
) {
	const checkCompareMap = (
		map: Record<string, unknown> | undefined,
		names: Set<string>,
		kind: 'var' | 'counter'
	) => {
		for (const [name, val] of Object.entries(map ?? {})) {
			if (!names.has(name)) issues.push(`${ctx}: ${kind} '${name}' is not declared in state.`);
			if (typeof val === 'string' && !refs.thresholdNames.has(val)) {
				issues.push(`${ctx}: ${kind} '${name}' uses unknown threshold '${val}'.`);
			}
		}
	};

	if (pred.flag && !refs.flagNames.has(pred.flag)) {
		issues.push(`${ctx}: unknown flag '${pred.flag}'.`);
	}
	if (pred.notFlag && !refs.flagNames.has(pred.notFlag)) {
		issues.push(`${ctx}: unknown flag '${pred.notFlag}'.`);
	}
	for (const f of pred.allFlags ?? []) {
		if (!refs.flagNames.has(f)) issues.push(`${ctx}: allFlags references unknown flag '${f}'.`);
	}
	for (const f of pred.anyFlags ?? []) {
		if (!refs.flagNames.has(f)) issues.push(`${ctx}: anyFlags references unknown flag '${f}'.`);
	}
	for (const f of pred.countFlags?.of ?? []) {
		if (!refs.flagNames.has(f)) issues.push(`${ctx}: countFlags references unknown flag '${f}'.`);
	}
	checkCompareMap(pred.var, refs.varNames, 'var');
	checkCompareMap(pred.counter, refs.counterNames, 'counter');

	if (pred.label !== undefined) {
		if (!classifier) {
			issues.push(`${ctx}: 'label' used without a classifier context.`);
		} else if (!classifier.output.label.some((l) => l.id === pred.label)) {
			issues.push(`${ctx}: label '${pred.label}' is not in classifier's enum.`);
		}
	}
	if (pred.target !== undefined) {
		if (!classifier) issues.push(`${ctx}: 'target' used without a classifier context.`);
		else if (!classifier.output.target) issues.push(`${ctx}: classifier declares no 'target' output.`);
		else if (!classifier.output.target.values.includes(pred.target)) {
			issues.push(`${ctx}: target '${pred.target}' is not in classifier's target values.`);
		}
	}
	if (pred.evidence !== undefined) {
		if (!classifier) issues.push(`${ctx}: 'evidence' used without a classifier context.`);
		else if (!classifier.output.evidencePresented) {
			issues.push(`${ctx}: classifier declares no 'evidencePresented' output.`);
		} else if (!classifier.output.evidencePresented.values.includes(pred.evidence)) {
			issues.push(`${ctx}: evidence '${pred.evidence}' is not in classifier's evidence values.`);
		}
	}

	for (const sub of pred.and ?? []) validatePredicate(sub, classifier, `${ctx} (and)`, refs, issues);
	for (const sub of pred.or ?? []) validatePredicate(sub, classifier, `${ctx} (or)`, refs, issues);
}

// BFS from `start`; an ending is reachable if we hit a terminal node, a node with an
// `ending:` ref, or a transition/goto pointing directly at an ending id.
function hasReachableEnding(
	script: Script,
	nodeIds: Set<string>,
	endingIds: Set<string>
): boolean {
	const nodeMap = new Map(script.nodes.map((n) => [n.id, n]));
	const globalTargets = script.global
		? script.global.decision.transitions.map((t) => t.to)
		: [];

	const visited = new Set<string>();
	const queue: string[] = ['start'];

	while (queue.length) {
		const id = queue.shift()!;
		if (visited.has(id)) continue;
		visited.add(id);

		if (endingIds.has(id)) return true;
		const node = nodeMap.get(id);
		if (!node) continue;
		if (node.terminal || node.ending) return true;

		const successors: string[] = [];
		if (node.goto) successors.push(node.goto);
		if (node.ending) successors.push(node.ending);
		const dec =
			typeof node.decision === 'string' ? script.decisions[node.decision] : node.decision;
		if (dec) for (const t of dec.transitions) successors.push(t.to);
		successors.push(...globalTargets);

		for (const s of successors) {
			if (endingIds.has(s)) return true;
			if (nodeIds.has(s) && !visited.has(s)) queue.push(s);
		}
	}
	return false;
}

// --- classifier → Mistral strict JSON schema -------------------------------

export function buildClassifierJsonSchema(classifier: Classifier): ClassifierJsonSchema {
	const properties: Record<string, unknown> = {
		label: { type: 'string', enum: classifier.output.label.map((l) => l.id) }
	};
	const required = ['label'];

	const addEnum = (name: string, field?: { nullable?: boolean; values: string[] }) => {
		if (!field) return;
		properties[name] = field.nullable
			? { type: ['string', 'null'], enum: [...field.values, null] }
			: { type: 'string', enum: field.values };
		required.push(name);
	};
	addEnum('target', classifier.output.target);
	addEnum('evidencePresented', classifier.output.evidencePresented);

	return { type: 'object', properties, required, additionalProperties: false };
}
