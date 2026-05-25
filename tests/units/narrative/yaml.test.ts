// Tests focalisés sur le parser YAML interne (`src/lib/narrative/yaml.ts`).
// Le moteur narratif est hermétique : on parse via son propre mini-parser, donc on doit
// pouvoir compter sur des messages d'erreur exploitables, notamment le numéro de ligne.

import { describe, expect, test } from 'vitest';
import { parseYaml, YamlParseError } from '../../../src/lib/narrative/yaml';

describe('parseYaml — diagnostics', () => {
	test("YamlParseError porte le numéro de ligne réel sur un flow map malformé", () => {
		// Le flow map `{bar baz}` sur la 3ᵉ ligne n'a pas de séparateur `:`.
		// La régression cible exactement le « -1 » historique : on s'assure que
		// `.line` pointe sur la vraie ligne (1-based) et n'est pas -1.
		const broken = [
			'root:',
			'  child: ok',
			'  oops: {bar baz}',
			'  tail: 1'
		].join('\n');

		let thrown: unknown;
		try {
			parseYaml(broken);
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeInstanceOf(YamlParseError);
		const err = thrown as YamlParseError;
		expect(err.line).toBeGreaterThan(0);
		expect(err.line).not.toBe(-1);
		// `line` est 0-based dans la classe ; le message contient la version 1-based.
		expect(err.message).toContain('line 3');
		expect(err.message).toContain('bar baz');
	});
});
