// Point d'entrée public du moteur narratif scripted.
// HERMÉTIQUE : aucun import vers $lib/i18n, $lib/zschemas/scenario.schema, ou autres
// modules dépendant de svelte-i18n. Peut être importé depuis n'importe quel contexte.

export { parseYaml } from './yaml';
export type { YamlValue } from './yaml';
export { compile } from './compile';
export { step } from './engine';
export { evaluate } from './conditions';
export { applyEffect } from './effects';
export { initialState } from './types';
export type {
	CharacterFixture,
	CompiledScenario,
	Condition,
	Effect,
	EndFixture,
	EvidenceFixture,
	NodeFixture,
	PlayerInput,
	ScenarioRules,
	ScriptedScenarioFixture,
	SessionState,
	StateAxisFixture,
	StepResult
} from './types';
