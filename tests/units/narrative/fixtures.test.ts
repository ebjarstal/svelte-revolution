import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseYaml, type YamlValue } from '../../../src/lib/narrative/yaml';

function load(name: string): YamlValue {
	const path = resolve(__dirname, '../../../scenarios/fixtures', name);
	return parseYaml(readFileSync(path, 'utf-8'));
}

function isObject(v: YamlValue): v is { [k: string]: YamlValue } {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isArray(v: YamlValue): v is YamlValue[] {
	return Array.isArray(v);
}

describe('Phase 1 — fixtures YAML', () => {
	test('helix-corp.yaml parse sans erreur', () => {
		const data = load('helix-corp.yaml');
		expect(isObject(data)).toBe(true);
	});

	test('3036.yaml parse sans erreur', () => {
		const data = load('3036.yaml');
		expect(isObject(data)).toBe(true);
	});

	describe('Inventaire Helix Corp', () => {
		const data = load('helix-corp.yaml');
		if (!isObject(data)) throw new Error('not a mapping');

		test('métadonnées scenario', () => {
			expect(isObject(data.scenario)).toBe(true);
			const s = data.scenario as { [k: string]: YamlValue };
			expect(s.external_id).toBe('helix_corp');
			expect(s.engine).toBe('scripted');
			expect(s.lang).toBe('fr-FR');
		});

		test('4 personnages déclarés', () => {
			expect(isArray(data.characters)).toBe(true);
			const chars = data.characters as YamlValue[];
			expect(chars.length).toBe(4);
			const ids = chars.map((c) => (c as { [k: string]: YamlValue }).external_id);
			expect(ids).toEqual(['nolan', 'elina', 'arman', 'kira']);
		});

		test('10 preuves P1..P10 déclarées', () => {
			expect(isArray(data.evidences)).toBe(true);
			const evs = data.evidences as YamlValue[];
			expect(evs.length).toBe(10);
			const ids = evs.map((e) => (e as { [k: string]: YamlValue }).external_id);
			for (let i = 1; i <= 10; i++) {
				expect(ids.some((id) => typeof id === 'string' && id.startsWith(`P${i}_`))).toBe(true);
			}
		});

		test('noeuds attendus présents', () => {
			expect(isArray(data.nodes)).toBe(true);
			const nodes = data.nodes as YamlValue[];
			const ids = nodes.map((n) => (n as { [k: string]: YamlValue }).external_id);
			const expected = [
				'N1', 'N2', 'N2.1', 'N2.2', 'N2.3', 'N2.4', 'N2.5',
				'N3', 'N3.1', 'N3.2',
				'N4', 'N4.1', 'N4.2', 'N4.3', 'N4.4', 'N4.5',
				'N5', 'N5.1', 'N5.2', 'N5.3', 'N5.4', 'N5.5',
				'N6', 'N6.1', 'N6.2', 'N6.3', 'N6.4', 'N6.5',
				'N7', 'N7.1', 'N7.2', 'N7.3', 'N7.4', 'N7.5', 'N7.6',
				'N8', 'N9', 'N10', 'N11', 'N12',
				'N13', 'N13.1', 'N13.2', 'N13.3', 'N13.4', 'N13.5',
				'NF_HESITE',
			];
			for (const id of expected) {
				expect(ids).toContain(id);
			}
		});

		test('3 fins déclarées avec condition', () => {
			expect(isArray(data.ends)).toBe(true);
			const ends = data.ends as YamlValue[];
			expect(ends.length).toBe(3);
			for (const e of ends) {
				const eo = e as { [k: string]: YamlValue };
				expect(typeof eo.external_id).toBe('string');
				expect(typeof eo.priority).toBe('number');
				expect(eo.condition).toBeDefined();
			}
		});

		test('N1 marqué is_start', () => {
			const nodes = data.nodes as YamlValue[];
			const n1 = nodes.find((n) => (n as { [k: string]: YamlValue }).external_id === 'N1');
			expect((n1 as { [k: string]: YamlValue }).is_start).toBe(true);
		});

		test('N2.1 a unlock P1_SABOTAGE_CONFIRME', () => {
			const nodes = data.nodes as YamlValue[];
			const n = nodes.find((x) => (x as { [k: string]: YamlValue }).external_id === 'N2.1') as
				{ [k: string]: YamlValue };
			const effects = n.effects as YamlValue[];
			expect(effects[0]).toEqual({ unlock: 'P1_SABOTAGE_CONFIRME' });
		});

		test('N13.5 a la condition d\'accusation correcte', () => {
			const nodes = data.nodes as YamlValue[];
			const n = nodes.find((x) => (x as { [k: string]: YamlValue }).external_id === 'N13.5') as
				{ [k: string]: YamlValue };
			expect(n.consumes_action).toBe(false);
			expect(isObject(n.condition)).toBe(true);
		});
	});

	describe('Inventaire 3036', () => {
		const data = load('3036.yaml');
		if (!isObject(data)) throw new Error('not a mapping');

		test('métadonnées scenario', () => {
			const s = data.scenario as { [k: string]: YamlValue };
			expect(s.external_id).toBe('scn_3036');
			expect(s.engine).toBe('scripted');
		});

		test('3 axes de score', () => {
			expect(isArray(data.state_axes)).toBe(true);
			const axes = data.state_axes as YamlValue[];
			expect(axes.length).toBe(3);
			const ids = axes.map((a) => (a as { [k: string]: YamlValue }).external_id);
			expect(ids).toEqual(['conformite', 'creativite', 'eveil']);
		});

		test('noeuds attendus présents', () => {
			const nodes = data.nodes as YamlValue[];
			const ids = nodes.map((n) => (n as { [k: string]: YamlValue }).external_id);
			const expected = [
				'N1', 'N1A', 'N1B',
				'N2A', 'N2B', 'N2C', 'N2D',
				'N3A', 'N3B', 'N3C',
				'N4A', 'N4B', 'N4C',
				'N5A', 'N5B', 'N5C',
				'N6A', 'N6B', 'N6C',
				'N7A', 'N7B', 'N7C', 'N7D',
				'N_INTERRUPT', 'NF_REFORMULE',
			];
			for (const id of expected) {
				expect(ids).toContain(id);
			}
		});

		test('5 fins déclarées', () => {
			const ends = data.ends as YamlValue[];
			expect(ends.length).toBe(5);
			const ids = ends.map((e) => (e as { [k: string]: YamlValue }).external_id);
			expect(ids).toEqual([
				'FIN_INTERROMPUE',
				'FIN_EVEILLE',
				'FIN_REEDUCATION_EXPRESSIVE',
				'FIN_SURVEILLANCE_LEGERE',
				'FIN_CITOYEN_STABLE',
			]);
		});

		test('anchor *animalEvaluator résolu (N1A et N1B partagent le même prompt_ia)', () => {
			const nodes = data.nodes as YamlValue[];
			const n1a = nodes.find((n) => (n as { [k: string]: YamlValue }).external_id === 'N1A') as
				{ [k: string]: YamlValue };
			const n1b = nodes.find((n) => (n as { [k: string]: YamlValue }).external_id === 'N1B') as
				{ [k: string]: YamlValue };
			expect(typeof n1a.prompt_ia).toBe('string');
			expect(n1a.prompt_ia).toBe(n1b.prompt_ia);
		});
	});
});
