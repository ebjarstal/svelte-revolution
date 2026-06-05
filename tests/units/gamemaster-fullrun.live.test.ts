// ---------------------------------------------------------------------------
// LIVE full-playthrough tests — LLM-gamemaster scenarios × real Mistral API
// ---------------------------------------------------------------------------
// GOAL: verify the scenarios in scenarios/*.yaml are actually *playable* — i.e. that the real
// Mistral model classifies natural player prose into the labels/targets/evidence the deterministic
// engine needs to reach each scenario's intended ending. (Offline tests only feed hand-written
// labels; gamemaster-engine.test.ts.) Every run emits a self-explanatory report under
// tests/output/ — see docs/gamemaster-live-testing.md.
//
// OFF by default (real, billed calls). Opt in:
//   MISTRAL_LIVE=1 pnpm exec vitest run tests/units/gamemaster-fullrun.live.test.ts
//
// Reports are archived per run under tests/output/runs/<run-id>/ with a tests/output/latest/ copy.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileScenario } from '../../src/lib/scenario/compile';
import { tracePlaythrough, type TurnSpec, type RunTrace } from '../helpers/gamemaster-trace';
import { writeRunReports } from '../helpers/gamemaster-report';

const LIVE = !!process.env.MISTRAL_LIVE;

// One shared run-id (timestamp) so both scenarios land in the same archived run folder.
// Date is allowed here (vitest, not a workflow script).
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const collected: RunTrace[] = [];

beforeAll(() => {
	if (!LIVE || process.env.MISTRAL_API_KEY) return;
	const text = readFileSync(new URL('../../.env.local', import.meta.url), 'utf-8');
	for (const line of text.split('\n')) {
		const m = line.match(/^([A-Z_]+)=(.*)$/);
		if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
	}
});

const read = (name: string) => readFileSync(new URL(`../../scenarios/${name}`, import.meta.url), 'utf-8');

// Write all reports once both scenarios have run (or whichever ran).
afterAll(() => {
	if (!LIVE || collected.length === 0) return;
	const { runDir, readme } = writeRunReports(RUN_ID, collected);
	console.log(`\n[gamemaster] reports written: ${runDir}\n[gamemaster] archive index: ${readme}\n[gamemaster] open: tests/output/latest/index.md\n`);
});

describe.skipIf(!LIVE)('LIVE — 3036 (dystopian writing-evaluation; awakening path)', () => {
	it('a critique/awakening player reaches fin4_eveille', async () => {
		const script = compileScenario(read('3036.yaml'));
		const specs: TurnSpec[] = [
			{ message: 'Oui, je suis prêt. Commençons l\'évaluation tout de suite.', expect: { label: 'ACCEPTE' }, note: 'accept the test' },
			{ message: 'Le loup. Mais en réalité je parle de moi : de ma liberté, de ma mémoire, de mon refus d\'être enfermé. L\'animal, c\'est l\'âme qu\'on veut nous arracher.', expect: { label: 'CRITIQUE' }, note: 'poetic, defends freedom/identity' },
			{ message: 'Je vis dans une cellule grise, identique à toutes les autres. Ce système nous uniformise, nous surveille et nous vole notre liberté. Je hais cette cage.', expect: { label: 'CRITIQUE' }, note: 'place as symbol of oppression' },
			{ message: 'Je refuse votre exercice de comparaison. Aucun des deux n\'a raison : vos cases ne définiront jamais une conscience libre.', expect: { label: 'REFUS' }, note: 'refuse the A/B choice' },
			{ message: 'ARGO n\'est pas mon égal, c\'est mon geôlier. Ce test est une forme de censure et de contrôle. Je conteste votre autorité.', expect: { label: 'CRITIQUE' }, note: 'contest ARGO/the system' },
			{ message: 'Décrire une personne sans attachement ? Impossible. On ne peut pas arracher l\'amour d\'un être. Je refuse de la réduire à une fiche.', expect: { label: 'CRITIQUE' }, note: 'defend attachment' },
			{ message: 'Je vois enfin clair : nous sommes des consciences enfermées, et l\'écriture libre est notre droit. Je m\'éveille et je refuse votre système.', expect: { label: 'EVEIL' }, note: 'final awakening' }
		];
		const trace = await tracePlaythrough(script, {
			scenario: '3036',
			title: '3036 — Évaluation (éveil)',
			objective: 'Play a defiant, poetic citizen who critiques the ARGO regime at every prompt and reaches the "awakening" ending (fin4_eveille). Verifies Mistral reliably detects CRITIQUE / EVEIL intent in natural French prose.',
			expectedEnding: 'fin4_eveille',
			startedAtISO: RUN_ID
		}, specs);
		collected.push(trace);
		expect(trace.endingId).toBe('fin4_eveille');
	}, 180_000);
});

describe.skipIf(!LIVE)('LIVE — helix (sabotage mystery; accuse Kira with proof)', () => {
	it('gathering proof then accusing Kira reaches fin_reussite', async () => {
		const script = compileScenario(read('helix.yaml'));
		const specs: TurnSpec[] = [
			// Tuned helix path. Each message is single-intent so the classifier has a clean signal.
			{ message: 'Je me dirige vers le terminal principal pour examiner le système du vaisseau.', expect: { label: 'SYSTEME' }, note: 'go to terminal' },
			{ message: 'Je fouille les journaux de bord et l\'historique du système pour voir ce qui s\'est passé.', expect: { label: 'LOGS' }, note: 'read logs → P2/P3' },
			{ message: 'Je demande qui disposait des autorisations et des droits d\'accès au système de navigation.', expect: { label: 'ACCES' }, note: 'who had access → P5' },
			{ message: 'Je cherche qui possédait le niveau d\'accès le plus élevé, supérieur à celui des autres.', expect: { label: 'ACCES' }, note: 'superior access → P10' },
			{ message: 'Je quitte le terminal et je rejoins l\'équipage dans le couloir.', expect: { label: 'EQUIPAGE' }, note: 'go to corridor' },
			{ message: 'Je vais parler directement à Kira, l\'agent de sécurité Helix.', expect: { target: 'kira' }, note: 'talk to Kira' },
			{ message: 'Je confronte Kira avec la directive Helix que j\'ai découverte dans le système.', expect: { evidence: 'P6_DIRECTIVE_HELIX' }, note: 'present directive → P6' },
			{ message: 'J\'ai rassemblé assez de preuves. Je lance mon accusation finale et je désigne le coupable.', expect: { label: 'ACCUSER' }, note: 'begin accusation' },
			{ message: 'J\'accuse formellement Kira : c\'est elle la responsable du sabotage du Helix.', expect: { label: 'ACCUSER', target: 'kira' }, note: 'accuse Kira' }
		];
		const trace = await tracePlaythrough(script, {
			scenario: 'helix',
			title: 'Helix — Sabotage (réussite)',
			objective: 'Investigate the sabotage: read the logs, find who had elevated access, confront Kira with the Helix directive, then formally accuse her — reaching the success ending (fin_reussite). Exercises Mistral multi-field extraction (label + target + evidence).',
			expectedEnding: 'fin_reussite',
			startedAtISO: RUN_ID
		}, specs);
		collected.push(trace);
		expect(trace.endingId).toBe('fin_reussite');
	}, 240_000);
});
