// Test de régression du dispatcher de moteur (cf. Phase 5.4).
// Garantit que la condition `engine === 'scripted'` est la SEULE qui route vers
// `progressScripted` — toute autre valeur (free, absent, null, etc.) doit faire
// tomber sur le chemin free original. Le fichier `+page.server.ts` lui-même n'est
// pas testable en isolation sous Vitest (import `$env/static/private`), d'où ce
// helper extrait.

import { describe, expect, test } from 'vitest';
import { isScriptedScenario } from '../../../src/lib/scenario/engine-dispatch';

describe('isScriptedScenario — dispatcher moteur scripted vs free', () => {
	test('renvoie true quand engine === "scripted"', () => {
		expect(isScriptedScenario({ expand: { scenario: { engine: 'scripted' } } })).toBe(true);
	});

	test('renvoie false quand engine === "free"', () => {
		expect(isScriptedScenario({ expand: { scenario: { engine: 'free' } } })).toBe(false);
	});

	test('renvoie false quand engine est absent (scénario legacy free)', () => {
		expect(isScriptedScenario({ expand: { scenario: {} } })).toBe(false);
	});

	test('renvoie false quand expand.scenario est absent', () => {
		expect(isScriptedScenario({ expand: {} })).toBe(false);
	});

	test('renvoie false quand expand est absent', () => {
		expect(isScriptedScenario({})).toBe(false);
	});

	test('renvoie false quand session est null/undefined', () => {
		expect(isScriptedScenario(null)).toBe(false);
		expect(isScriptedScenario(undefined)).toBe(false);
	});

	test('renvoie false sur valeurs engine inattendues', () => {
		expect(isScriptedScenario({ expand: { scenario: { engine: 'SCRIPTED' } } })).toBe(false);
		expect(isScriptedScenario({ expand: { scenario: { engine: '' } } })).toBe(false);
		expect(isScriptedScenario({ expand: { scenario: { engine: 'hybrid' } } })).toBe(false);
	});
});
