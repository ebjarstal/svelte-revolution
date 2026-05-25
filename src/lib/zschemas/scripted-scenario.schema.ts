// Zod schema for scripted scenario fixtures (YAML format defined in
// docs/narrative-engine-design.md §10.2). DSL grammar §4 (conditions) and §5 (effects).
// HERMÉTIQUE : aucune dépendance vers $lib/i18n ou vers d'autres zschemas — peut être
// importé depuis n'importe quel contexte (server, client, tests Vitest) sans déclencher
// l'initialisation de svelte-i18n.

import { z } from 'zod';

// ─── Identifiants ────────────────────────────────────────────────────────────
const nonEmptyString = z.string().min(1);
const nodeIdSchema = nonEmptyString;
const intentLabelSchema = nonEmptyString;
const evidenceIdSchema = nonEmptyString;
const axisIdSchema = nonEmptyString;
const characterIdSchema = nonEmptyString;
const classLabelSchema = nonEmptyString;
const endIdSchema = nonEmptyString;

const scoreLevelSchema = z.enum(['faible', 'moyen', 'eleve']);

// Comparateur numérique (gte / lte / eq). Sans aucun des trois, le prédicat retournerait
// FAIL silencieusement à l'évaluation runtime — piège pour l'auteur, donc rejet à la
// validation Zod. Factory pour nommer le prédicat appelant dans le message d'erreur.
const makeComparatorSchema = (predicateName: string) =>
	z
		.object({
			gte: z.number().optional(),
			lte: z.number().optional(),
			eq: z.number().optional()
		})
		.refine(
			(c) => c.gte !== undefined || c.lte !== undefined || c.eq !== undefined,
			{ message: `${predicateName} doit avoir au moins gte / lte / eq` }
		);

// ─── DSL conditions (§4) ─────────────────────────────────────────────────────
// L'objet condition est un sac de prédicats reliés implicitement par `all` au
// top-level, et peut aussi contenir les combinateurs `all` / `any` / `not`.
export type Condition = {
	// combinateurs
	all?: Condition[];
	any?: Condition[];
	not?: Condition;
	// topologie
	from?: string;
	after?: string;
	last?: string[];
	visited?: string[];
	// intent
	intent_in?: string[];
	// target (PNJ)
	target?: string;
	// preuve
	has?: string;
	has_any?: string[];
	has_all?: string[];
	has_count_gte?: number;
	has_count_among?: { ids: string[]; gte?: number; lte?: number };
	// score
	score?: { axis: string; gte?: number; lte?: number; eq?: number };
	score_level?: { axis: string; level: 'faible' | 'moyen' | 'eleve' };
	// actions
	actions_left?: { gte?: number; lte?: number; eq?: number };
	// classification (3036)
	classification_is?: string;
	// warnings
	warnings?: { gte?: number; lte?: number; eq?: number };
};

// Refine appliqué uniquement au niveau `node.condition` / `end.condition` : refuse
// `condition: {}` (piège typo style « form » au lieu de « from »). Pas posé sur la
// définition récursive de `conditionSchema` car le moteur tolère qu'un enfant de
// `all`/`any`/`not` n'apporte aucun prédicat (`evaluate({}, ctx)` = true, spécificité 0).
const nonEmptyConditionRefine = (c: Condition): boolean => Object.keys(c).length > 0;
const nonEmptyConditionMessage = 'condition must contain at least one predicate';

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
	z
		.object({
			all: z.array(conditionSchema).optional(),
			any: z.array(conditionSchema).optional(),
			not: conditionSchema.optional(),
			from: nodeIdSchema.optional(),
			after: nodeIdSchema.optional(),
			last: z.array(nodeIdSchema).optional(),
			visited: z.array(nodeIdSchema).optional(),
			intent_in: z.array(intentLabelSchema).optional(),
			target: characterIdSchema.optional(),
			has: evidenceIdSchema.optional(),
			has_any: z.array(evidenceIdSchema).optional(),
			has_all: z.array(evidenceIdSchema).optional(),
			has_count_gte: z.number().optional(),
			has_count_among: z
				.object({
					ids: z.array(evidenceIdSchema),
					gte: z.number().optional(),
					lte: z.number().optional()
				})
				.refine(
					(c) => c.gte !== undefined || c.lte !== undefined,
					{ message: 'has_count_among doit avoir au moins gte / lte' }
				)
				.optional(),
			score: z
				.object({
					axis: axisIdSchema,
					gte: z.number().optional(),
					lte: z.number().optional(),
					eq: z.number().optional()
				})
				.refine(
					(c) => c.gte !== undefined || c.lte !== undefined || c.eq !== undefined,
					{ message: 'score doit avoir au moins gte / lte / eq' }
				)
				.optional(),
			score_level: z
				.object({ axis: axisIdSchema, level: scoreLevelSchema })
				.optional(),
			actions_left: makeComparatorSchema('actions_left').optional(),
			classification_is: classLabelSchema.optional(),
			warnings: makeComparatorSchema('warnings').optional()
		})
		.strict()
);

// ─── DSL effets (§5) ─────────────────────────────────────────────────────────
export type Effect =
	| { unlock: string }
	| { score: { axis: string; delta: number } }
	| { warnings: { delta: number } }
	| { actions: { delta: number } }
	| { set_classification: string }
	| { end: string };

export const effectSchema: z.ZodType<Effect> = z.union([
	z.object({ unlock: evidenceIdSchema }).strict(),
	z.object({ score: z.object({ axis: axisIdSchema, delta: z.number() }).strict() }).strict(),
	z.object({ warnings: z.object({ delta: z.number() }).strict() }).strict(),
	z.object({ actions: z.object({ delta: z.number() }).strict() }).strict(),
	z.object({ set_classification: classLabelSchema }).strict(),
	z.object({ end: endIdSchema }).strict()
]);

// ─── Sous-objets de la fixture YAML ─────────────────────────────────────────
export const intentDeclSchema = z
	.object({ label: intentLabelSchema, description: z.string() })
	.strict();

export const nodeFixtureSchema = z
	.object({
		external_id: nodeIdSchema,
		titre: z.string().optional(),
		texte: z.string().optional(),
		is_start: z.boolean().optional(),
		consumes_action: z.boolean().optional(),
		prompt_ia: z.string().optional(),
		intents: z.array(intentDeclSchema).optional(),
		condition: conditionSchema
			.refine(nonEmptyConditionRefine, { message: nonEmptyConditionMessage })
			.optional(),
		effects: z.array(effectSchema).optional()
	})
	.strict();

export const endFixtureSchema = z
	.object({
		external_id: endIdSchema,
		title: z.string(),
		priority: z.number(),
		text: z.string(),
		condition: conditionSchema
			.refine(nonEmptyConditionRefine, { message: nonEmptyConditionMessage })
			.optional()
	})
	.strict();

export const characterFixtureSchema = z
	.object({
		external_id: characterIdSchema,
		name: z.string(),
		role: z.string().optional(),
		bio: z.string().optional()
	})
	.strict();

export const evidenceFixtureSchema = z
	.object({
		external_id: evidenceIdSchema,
		label: z.string(),
		description: z.string().optional()
	})
	.strict();

export const stateAxisFixtureSchema = z
	.object({
		external_id: axisIdSchema,
		label: z.string(),
		description: z.string().optional()
	})
	.strict();

export const rulesSchema = z
	.object({
		initial_actions: z.number().nullable().optional(),
		score_caps: z.record(z.string(), z.number()).optional(),
		score_thresholds: z
			.object({ faible: z.string(), moyen: z.string(), eleve: z.string() })
			.optional(),
		fallback_node: z.string().nullable().optional(),
		end_eval_after: z.string().nullable().optional()
	})
	.strict();

export const scenarioMetaSchema = z
	.object({
		external_id: nonEmptyString,
		title: z.string(),
		prologue: z.string(),
		lang: z.string(),
		engine: z.enum(['free', 'scripted'])
	})
	.strict();

export const scriptedScenarioSchema = z
	.object({
		scenario: scenarioMetaSchema,
		rules: rulesSchema,
		characters: z.array(characterFixtureSchema),
		evidences: z.array(evidenceFixtureSchema),
		state_axes: z.array(stateAxisFixtureSchema),
		nodes: z.array(nodeFixtureSchema),
		ends: z.array(endFixtureSchema)
	})
	.strict();

export type ScriptedScenarioFixture = z.infer<typeof scriptedScenarioSchema>;
export type NodeFixture = z.infer<typeof nodeFixtureSchema>;
export type EndFixture = z.infer<typeof endFixtureSchema>;
export type CharacterFixture = z.infer<typeof characterFixtureSchema>;
export type EvidenceFixture = z.infer<typeof evidenceFixtureSchema>;
export type StateAxisFixture = z.infer<typeof stateAxisFixtureSchema>;
export type ScenarioRules = z.infer<typeof rulesSchema>;
