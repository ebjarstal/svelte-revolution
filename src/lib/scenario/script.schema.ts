// Zod schema for the LLM-gamemaster scenario *script* (see docs/llm-gamemaster-design.md §4).
// This validates the shape of a parsed YAML scenario. Semantic / cross-reference checks
// (dangling `to:`, undeclared flags, etc.) live in compile.ts — Zod only enforces structure.

import { z } from 'zod';

// --- numeric comparison: { gt?, gte?, lt?, lte?, eq? } ---------------------
const numComparators = {
	gt: z.number().optional(),
	gte: z.number().optional(),
	lt: z.number().optional(),
	lte: z.number().optional(),
	eq: z.number().optional()
} as const;

export const numCompareSchema = z.strictObject({ ...numComparators });
export type NumCompare = z.infer<typeof numCompareSchema>;

// A var/counter comparison is either a comparator object or a named threshold (string sugar).
const compareValueSchema = z.union([z.string(), numCompareSchema]);

const countFlagsSchema = z.strictObject({
	of: z.array(z.string()),
	...numComparators
});

// --- predicate (the `when` of a transition or an ending) -------------------
// Recursive (and/or), so it needs an explicit type annotation.
export type Predicate = {
	label?: string;
	target?: string;
	evidence?: string;
	flag?: string;
	notFlag?: string;
	allFlags?: string[];
	anyFlags?: string[];
	countFlags?: { of: string[] } & NumCompare;
	var?: Record<string, NumCompare | string>;
	counter?: Record<string, NumCompare | string>;
	from?: string[]; // source-scoping (global decision): node id, "after:nX", or "*"
	and?: Predicate[];
	or?: Predicate[];
	never?: boolean;
};

export const predicateSchema: z.ZodType<Predicate> = z.lazy(() =>
	z.strictObject({
		label: z.string().optional(),
		target: z.string().optional(),
		evidence: z.string().optional(),
		flag: z.string().optional(),
		notFlag: z.string().optional(),
		allFlags: z.array(z.string()).optional(),
		anyFlags: z.array(z.string()).optional(),
		countFlags: countFlagsSchema.optional(),
		var: z.record(z.string(), compareValueSchema).optional(),
		counter: z.record(z.string(), compareValueSchema).optional(),
		from: z.array(z.string()).optional(),
		and: z.array(predicateSchema).optional(),
		or: z.array(predicateSchema).optional(),
		never: z.boolean().optional()
	})
);

// --- effects ---------------------------------------------------------------
export const effectsSchema = z.strictObject({
	vars: z.record(z.string(), z.number()).optional(),
	flags: z.record(z.string(), z.boolean()).optional(),
	counters: z.record(z.string(), z.number()).optional()
});
export type Effects = z.infer<typeof effectsSchema>;

// --- transitions & decisions ----------------------------------------------
export const transitionSchema = z.strictObject({
	when: predicateSchema.optional(),
	to: z.string(),
	effects: effectsSchema.optional()
});
export type Transition = z.infer<typeof transitionSchema>;

export const decisionSchema = z.strictObject({
	classifier: z.string(),
	transitions: z.array(transitionSchema)
});
export type Decision = z.infer<typeof decisionSchema>;

// --- classifiers -----------------------------------------------------------
const labelDefSchema = z.strictObject({
	id: z.string(),
	description: z.string().optional()
});

const enumFieldSchema = z.strictObject({
	nullable: z.boolean().optional(),
	values: z.array(z.string())
});

export const classifierSchema = z.strictObject({
	instructions: z.string(),
	output: z.strictObject({
		label: z.array(labelDefSchema),
		target: enumFieldSchema.optional(),
		evidencePresented: enumFieldSchema.optional()
	})
});
export type Classifier = z.infer<typeof classifierSchema>;

// --- nodes -----------------------------------------------------------------
export const nodeSchema = z.strictObject({
	id: z.string(),
	type: z.literal('start').optional(),
	title: z.string().optional(),
	text: z.string(),
	effects: effectsSchema.optional(),
	// a reference to a top-level decision, or an inline decision object
	decision: z.union([z.string(), decisionSchema]).optional(),
	goto: z.string().optional(), // unconditional next node
	terminal: z.boolean().optional(),
	ending: z.string().optional(), // reference to an ending id
	consume: z.record(z.string(), z.number()).optional() // per-node counter cost override
});
export type ScenarioNode = z.infer<typeof nodeSchema>;

// --- state -----------------------------------------------------------------
export const stateSchema = z.strictObject({
	vars: z.record(z.string(), z.number()).optional().default({}),
	// bare list (declares flags, default false) or explicit { name: bool } map
	flags: z
		.union([z.array(z.string()), z.record(z.string(), z.boolean())])
		.optional()
		.default([]),
	counters: z.record(z.string(), z.number()).optional().default({}),
	thresholds: z.record(z.string(), numCompareSchema).optional().default({})
});
export type ScenarioState = z.infer<typeof stateSchema>;

// --- endings ---------------------------------------------------------------
export const endingSchema = z.strictObject({
	id: z.string(),
	title: z.string(),
	terminal: z.boolean().optional(),
	when: predicateSchema,
	text: z.string()
});
export type Ending = z.infer<typeof endingSchema>;

// --- global decision -------------------------------------------------------
export const globalSchema = z.strictObject({
	consumePerMainNode: z.number().optional(),
	decision: decisionSchema
});

// --- meta ------------------------------------------------------------------
export const metaSchema = z.strictObject({
	id: z.string(),
	title: z.string(),
	lang: z.enum(['en', 'fr', 'jp']),
	schemaVersion: z.number()
});

// --- the whole script ------------------------------------------------------
export const scriptSchema = z.strictObject({
	meta: metaSchema,
	prologue: z.string(),
	state: stateSchema,
	classifiers: z.record(z.string(), classifierSchema),
	decisions: z.record(z.string(), decisionSchema).optional().default({}),
	global: globalSchema.optional(),
	nodes: z.array(nodeSchema),
	endings: z.array(endingSchema)
});
export type Script = z.infer<typeof scriptSchema>;
