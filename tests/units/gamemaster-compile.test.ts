import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileScenario, ScenarioCompileError } from '../../src/lib/scenario/compile';

const read = (name: string) =>
	readFileSync(new URL(`../../scenarios/${name}`, import.meta.url), 'utf-8');

// Helper: compile and return the thrown ScenarioCompileError (fails the test if none thrown).
function expectCompileError(yaml: string): ScenarioCompileError {
	let err: unknown;
	try {
		compileScenario(yaml);
	} catch (e) {
		err = e;
	}
	expect(err, 'expected compileScenario to throw').toBeInstanceOf(ScenarioCompileError);
	return err as ScenarioCompileError;
}

// A minimal, valid scenario used as the base for negative mutations.
const VALID = `
meta: { id: t, title: T, lang: fr, schemaVersion: 1 }
prologue: hello
state:
  vars: { score: 0 }
  flags: [F1]
  counters: { c: 1 }
classifiers:
  k:
    instructions: classify it
    output:
      label:
        - { id: A, description: a }
        - { id: B, description: b }
decisions:
  d:
    classifier: k
    transitions:
      - { when: { label: A, flag: F1 }, to: n1 }
      - { when: { label: B }, to: fin }
nodes:
  - { id: start, type: start, text: s, decision: d }
  - { id: n1, text: n1, effects: { vars: { score: 1 } } }
endings:
  - { id: fin, title: F, terminal: true, when: { var: { score: { gte: 1 } } }, text: bye }
`;

describe('compileScenario — conformance with authored scenarios', () => {
	it('compiles 3036.yaml', () => {
		const script = compileScenario(read('3036.yaml'));
		expect(script.meta.id).toBe('3036');
		expect(script.nodes.some((n) => n.id === 'start')).toBe(true);
		// classifier schema is built for every classifier
		expect(Object.keys(script.classifierSchemas).sort()).toEqual(
			Object.keys(script.classifiers).sort()
		);
		const animal = script.classifierSchemas.animal;
		expect(animal.required).toEqual(['label']);
		expect((animal.properties.label as { enum: string[] }).enum).toContain('CONFORME');
		expect(animal.additionalProperties).toBe(false);
	});

	it('compiles helix.yaml (non-linear, global decision, target/evidence)', () => {
		const script = compileScenario(read('helix.yaml'));
		expect(script.meta.id).toBe('helix');
		expect(script.global).toBeDefined();
		const intent = script.classifierSchemas.helix_intent;
		// target + evidencePresented become required, nullable enums
		expect(intent.required).toEqual(['label', 'target', 'evidencePresented']);
		expect(intent.properties.target).toMatchObject({ type: ['string', 'null'] });
		expect((intent.properties.target as { enum: unknown[] }).enum).toContain(null);
	});
});

describe('compileScenario — valid base', () => {
	it('accepts a minimal valid scenario', () => {
		const script = compileScenario(VALID);
		expect(script.meta.id).toBe('t');
		// flags list stays as declared
		expect(script.state.flags).toEqual(['F1']);
	});
});

describe('compileScenario — rejects bad input with clear errors', () => {
	it('rejects malformed YAML', () => {
		const err = expectCompileError('meta: [1, 2'); // unterminated flow sequence
		expect(err.issues.join('\n')).toContain('YAML parse error');
	});

	it('rejects a structurally invalid script (Zod)', () => {
		const err = expectCompileError(VALID.replace('lang: fr', 'lang: klingon'));
		expect(err.issues.join('\n')).toMatch(/meta\.lang/);
	});

	it('rejects an unknown top-level key (strict object)', () => {
		const err = expectCompileError(VALID + '\nbogus: 42\n');
		expect(err.issues.length).toBeGreaterThan(0);
	});

	it('rejects a dangling transition target', () => {
		const err = expectCompileError(VALID.replace('to: n1', 'to: does_not_exist'));
		expect(err.issues.some((i) => i.includes('resolves to no node or ending'))).toBe(true);
	});

	it('rejects a guard referencing an undeclared flag', () => {
		const err = expectCompileError(VALID.replace('flag: F1', 'flag: F_MISSING'));
		expect(err.issues.some((i) => i.includes("unknown flag 'F_MISSING'"))).toBe(true);
	});

	it('rejects a decision referencing an unknown classifier', () => {
		const err = expectCompileError(VALID.replace('classifier: k', 'classifier: nope'));
		expect(err.issues.some((i) => i.includes("unknown classifier 'nope'"))).toBe(true);
	});

	it('rejects a label not in the classifier enum', () => {
		const err = expectCompileError(VALID.replace('label: A, flag: F1', 'label: ZZZ, flag: F1'));
		expect(err.issues.some((i) => i.includes("label 'ZZZ' is not in classifier's enum"))).toBe(
			true
		);
	});

	it('rejects an effect setting an undeclared var', () => {
		const err = expectCompileError(VALID.replace('vars: { score: 1 }', 'vars: { ghost: 1 }'));
		expect(err.issues.some((i) => i.includes("effect sets unknown var 'ghost'"))).toBe(true);
	});

	it('requires a start node', () => {
		const err = expectCompileError(VALID.replace('id: start, type: start', 'id: begin, type: start'));
		expect(err.issues.some((i) => i.includes("Missing required 'start' node"))).toBe(true);
	});
});
