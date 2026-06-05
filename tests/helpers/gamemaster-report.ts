// ---------------------------------------------------------------------------
// Live gamemaster run REPORTER
// ---------------------------------------------------------------------------
// Renders a RunTrace (from gamemaster-trace.ts) into self-explanatory artifacts, organised so past
// runs are archived rather than overwritten:
//
//   tests/output/
//     README.md                    # archive index of ALL runs (newest first) + how to read
//     latest/                      # copy of the most recent run (convenience)
//       index.md  3036.md  3036.json  helix.md  helix.json
//     runs/
//       <run-id>/                  # one folder per invocation (timestamp-based)
//         manifest.json            # machine-readable run summary (drives the archive index)
//         index.md                 # this run's cross-scenario summary
//         <scenario>.md            # human report: prose + Mermaid diagram + transcript
//         <scenario>.json          # full structured trace
//
// Everything a reader needs to understand a report without this conversation's context is embedded
// in the artifacts themselves (goal, legend, glossary, how to re-run). See docs/gamemaster-live-testing.md.

import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { RunTrace, TurnTrace } from './gamemaster-trace';

const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'output');
const DASH = '—';

// ---- small formatting helpers ---------------------------------------------

const mdCell = (s: string) => s.replace(/\|/g, '\\|').replace(/[\n\r]+/g, ' ').trim();
const trunc = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const pct = (num: number, den: number) => (den === 0 ? 'n/a' : `${Math.round((100 * num) / den)}%`);
const yesno = (b: boolean | undefined) => (b === undefined ? DASH : b ? '✓' : '✗');

function aiCell(t: TurnTrace): string {
	const parts = [t.ai.label ?? DASH];
	if (t.ai.target != null) parts.push(`target=${t.ai.target}`);
	if (t.ai.evidencePresented != null) parts.push(`evidence=${t.ai.evidencePresented}`);
	if (t.fallback) parts.push('(FALLBACK)');
	return parts.join(' · ');
}

// ---- aggregate stats for the prose summary + scorecard --------------------

interface Stats {
	turns: number;
	labelChecked: number;
	labelHits: number;
	targetChecked: number;
	targetHits: number;
	evidenceChecked: number;
	evidenceHits: number;
	fallbacks: number;
	stuckTurns: number;
	selfLoops: number;
	avgLatency: number;
	flagsGathered: string[];
}

function computeStats(trace: RunTrace): Stats {
	let labelChecked = 0, labelHits = 0, targetChecked = 0, targetHits = 0, evidenceChecked = 0, evidenceHits = 0;
	let fallbacks = 0, stuckTurns = 0, selfLoops = 0;
	for (const t of trace.turns) {
		if (t.match.label !== undefined) { labelChecked++; if (t.match.label) labelHits++; }
		if (t.match.target !== undefined) { targetChecked++; if (t.match.target) targetHits++; }
		if (t.match.evidence !== undefined) { evidenceChecked++; if (t.match.evidence) evidenceHits++; }
		if (t.fallback) fallbacks++;
		if (!t.chosen) stuckTurns++;
		else if (t.toNode === t.fromNode && !t.reachedEnding) selfLoops++;
	}
	const flagsGathered = Object.keys(trace.finalState.flags).filter((k) => trace.finalState.flags[k]);
	return {
		turns: trace.turns.length,
		labelChecked, labelHits, targetChecked, targetHits, evidenceChecked, evidenceHits,
		fallbacks, stuckTurns, selfLoops,
		avgLatency: trace.turns.length ? Math.round(trace.totalLatencyMs / trace.turns.length) : 0,
		flagsGathered
	};
}

// ---- prose executive summary ----------------------------------------------

function executiveSummary(trace: RunTrace, s: Stats): string {
	const lines: string[] = [];
	const verdictWord = trace.verdict === 'PASS' ? 'succeeded' : 'did NOT reach its goal';
	lines.push(
		`This run played the **${trace.title}** scenario live against \`${trace.model}\`, aiming to ` +
		`reach the ending **\`${trace.expectedEnding}\`**. It ${verdictWord}.`
	);

	if (s.labelChecked > 0) {
		lines.push(
			`Mistral matched the expected **label** on **${s.labelHits}/${s.labelChecked}** ` +
			`scored turns (${pct(s.labelHits, s.labelChecked)}).` +
			(s.targetChecked ? ` Target: ${s.targetHits}/${s.targetChecked} (${pct(s.targetHits, s.targetChecked)}).` : '') +
			(s.evidenceChecked ? ` Evidence: ${s.evidenceHits}/${s.evidenceChecked} (${pct(s.evidenceHits, s.evidenceChecked)}).` : '')
		);
	}
	if (s.fallbacks > 0) lines.push(`⚠ **${s.fallbacks}** turn(s) hit the Mistral fallback (empty classification).`);

	if (trace.endingId) {
		lines.push(`The engine reached **\`${trace.endingId}\` — ${trace.endingTitle}** after ${s.turns} turn(s).`);
	} else {
		// describe where/why it stalled
		const stuck = trace.turns.find((t) => !t.chosen);
		const loop = trace.turns.find((t) => t.chosen && t.toNode === t.fromNode && !t.reachedEnding);
		if (stuck) {
			lines.push(
				`The run **stalled** at node **\`${stuck.fromNode}\`** (${stuck.fromNodeTitle}) on turn ${stuck.index}: ` +
				`the AI classified the message as \`${stuck.ai.label ?? DASH}\` but **no transition guard there accepted it**, ` +
				'so the engine made no move and the run never reached an ending.'
			);
		} else if (loop) {
			lines.push(
				`The run **looped** on node **\`${loop.fromNode}\`** (${loop.fromNodeTitle}) without forward progress, ` +
				'so it never accumulated what later endings require.'
			);
		} else {
			lines.push('The run ended without reaching a terminal ending (ran out of scripted turns).');
		}
	}

	if (s.flagsGathered.length) {
		lines.push(`Flags gathered: ${s.flagsGathered.map((f) => `\`${f}\``).join(', ')}.`);
	}
	lines.push(`Average classification latency: ${s.avgLatency} ms/turn (total ${trace.totalLatencyMs} ms).`);
	return lines.map((l) => l).join('\n\n');
}

// ---- Mermaid path diagram (each node declared once; ending highlighted) ----

const mEsc = (s: string) => s.replace(/"/g, '\'').replace(/[\n\r<>|{}[\]]/g, ' ').replace(/\s+/g, ' ').trim();

function mermaid(trace: RunTrace): string {
	const lines = ['flowchart TD'];
	const declared = new Set<string>();
	const declare = (id: string, title: string, kind: 'normal' | 'ending' | 'stuck') => {
		if (declared.has(id)) return;
		declared.add(id);
		const cls = kind === 'ending' ? ':::ending' : kind === 'stuck' ? ':::stuck' : '';
		lines.push(`  ${id}["${mEsc(title)}"]${cls}`);
	};
	for (const t of trace.turns) {
		const stuck = !t.chosen;
		declare(t.fromNode, `${t.fromNode}\n${t.fromNodeTitle}`, stuck ? 'stuck' : 'normal');
		const toIsEnd = t.toNode === trace.endingId;
		declare(t.toNode, toIsEnd ? `${t.toNode}\n${trace.endingTitle ?? ''}` : `${t.toNode}\n${t.toNodeTitle}`, toIsEnd ? 'ending' : 'normal');
		const lbl: string[] = [`#${t.index} ${t.ai.label ?? '?'}`];
		if (t.ai.target != null) lbl.push(`@${t.ai.target}`);
		if (t.ai.evidencePresented != null) lbl.push(`📎${t.ai.evidencePresented}`);
		if (t.match.label === false) lbl.push('⚠');
		if (stuck) {
			lines.push(`  ${t.fromNode} -. "${mEsc(lbl.join(' '))} (no match)" .-> ${t.fromNode}`);
		} else {
			lines.push(`  ${t.fromNode} -->|"${mEsc(lbl.join(' '))}"| ${t.toNode}`);
		}
	}
	lines.push('  classDef ending fill:#1b5e20,color:#fff,stroke:#66bb6a,stroke-width:2px;');
	lines.push('  classDef stuck fill:#5d1414,color:#fff,stroke:#ef5350,stroke-width:2px;');
	return lines.join('\n');
}

// ---- reusable legend / glossary (so reports stand alone) -------------------

const LEGEND = `> **How to read this report**
>
> Each turn, a (simulated) player sends a free-text message. The real Mistral model classifies it
> into a constrained **label** (and, for helix, a **target** character and any **evidence** invoked).
> The *deterministic* engine then picks the next authored node using that classification + game state.
> The diagram shows the path taken; dashed red self-arrows mark turns where **no transition matched**
> (a stall). Green = the ending reached. The transcript lists, per turn, what the player said, what
> the AI returned, whether it matched expectation (✓/✗), and what changed in game state.
>
> **Glossary** — *label*: the player's classified intent · *target*: which character the player
> addresses · *evidence*: a proof flag the player invokes · *flag*: a boolean fact gathered during
> play · *node*: one authored screen of narration · *ending*: a terminal node that concludes the run.`;

const RERUN = `_Regenerate:_ \`MISTRAL_LIVE=1 pnpm exec vitest run tests/units/gamemaster-fullrun.live.test.ts\`
(makes real, billed Mistral calls). Full background in \`docs/gamemaster-live-testing.md\`.`;

// ---- per-scenario markdown report -----------------------------------------

export function renderScenarioMarkdown(trace: RunTrace): string {
	const s = computeStats(trace);
	const o: string[] = [];
	const banner = trace.verdict === 'PASS' ? '✅ PASS' : '❌ FAIL';

	o.push(`# Live run — ${trace.title}  ${banner}`);
	o.push('');
	o.push(`*Run id:* \`${trace.startedAtISO}\` · *Model:* \`${trace.model}\``);
	o.push('');
	o.push(`**Objective.** ${trace.objective}`);
	o.push('');
	o.push(LEGEND);
	o.push('');

	o.push('## Summary');
	o.push('');
	o.push(executiveSummary(trace, s));
	o.push('');

	o.push('## Classification scorecard');
	o.push('');
	o.push('| Metric | Value |');
	o.push('|--------|-------|');
	o.push(`| Turns played | ${s.turns} |`);
	o.push(`| Label accuracy | ${s.labelHits}/${s.labelChecked} (${pct(s.labelHits, s.labelChecked)}) |`);
	if (s.targetChecked) o.push(`| Target accuracy | ${s.targetHits}/${s.targetChecked} (${pct(s.targetHits, s.targetChecked)}) |`);
	if (s.evidenceChecked) o.push(`| Evidence accuracy | ${s.evidenceHits}/${s.evidenceChecked} (${pct(s.evidenceHits, s.evidenceChecked)}) |`);
	o.push(`| Mistral fallbacks | ${s.fallbacks} |`);
	o.push(`| Stuck turns (no match) | ${s.stuckTurns} |`);
	o.push(`| Self-loops (no progress) | ${s.selfLoops} |`);
	o.push(`| Avg latency | ${s.avgLatency} ms/turn |`);
	o.push(`| Ending reached | ${trace.endingId ? `\`${trace.endingId}\` — ${trace.endingTitle}` : '— none —'} |`);
	o.push(`| Expected ending | \`${trace.expectedEnding}\` |`);
	o.push('');

	o.push('## Path');
	o.push('');
	o.push('```mermaid');
	o.push(mermaid(trace));
	o.push('```');
	o.push('');

	o.push('## Transcript');
	o.push('');
	o.push('| # | At node | Player said | AI classification | Match | → To node | State change |');
	o.push('|---|---------|-------------|-------------------|-------|-----------|--------------|');
	for (const t of trace.turns) {
		const matchBits = [
			t.match.label !== undefined ? `L${yesno(t.match.label)}` : '',
			t.match.target !== undefined ? `T${yesno(t.match.target)}` : '',
			t.match.evidence !== undefined ? `E${yesno(t.match.evidence)}` : ''
		].filter(Boolean).join(' ') || DASH;
		const changes = [
			...t.diff.flagsSet.map((f) => `+${f}`),
			...t.diff.countersChanged.map((c) => `${c.key} ${c.from}→${c.to}`),
			...t.diff.varsChanged.map((v) => `${v.key} ${v.from}→${v.to}`)
		].join(', ') || DASH;
		o.push(
			`| ${t.index} | ${mdCell(t.fromNodeTitle)} | ${mdCell(trunc(t.player))} | ${mdCell(aiCell(t))} | ${matchBits} | ` +
			`${t.chosen ? mdCell(t.toNodeTitle) : '**STUCK**'} | ${mdCell(changes)} |`
		);
	}
	o.push('');

	// Narration transcript (what the player actually sees)
	o.push('## Narration (what the player sees)');
	o.push('');
	for (const t of trace.turns) {
		o.push(`**Turn ${t.index}** — you: _${mdCell(trunc(t.player, 200))}_`);
		if (t.note) o.push(`<sub>(${mdCell(t.note)})</sub>`);
		for (const n of t.createdNodes) {
			o.push('');
			o.push(`> **${mdCell(n.title)}**  `);
			o.push('> ' + mdCell(trunc(n.text.replace(/\n+/g, ' '), 400)));
		}
		o.push('');
	}

	// Routing detail (collapsible)
	o.push('## Routing detail');
	o.push('');
	o.push('<details><summary>Per-turn candidate transitions the engine evaluated (click to expand)</summary>');
	o.push('');
	for (const t of trace.turns) {
		o.push(`**Turn ${t.index} @ \`${t.fromNode}\`** — classifier \`${t.classifier.id ?? DASH}\` (${t.classifier.source}); AI → ${mdCell(aiCell(t))}`);
		o.push('');
		o.push('| src | guard (`when`) | → | matched | winner |');
		o.push('|-----|----------------|---|---------|--------|');
		for (const c of t.candidates) {
			o.push(`| ${c.source} | \`${mdCell(JSON.stringify(c.when ?? 'unconditional'))}\` | ${c.to} | ${c.matched ? '✓' : ''} | ${c.winner ? '★' : ''} |`);
		}
		o.push('');
	}
	o.push('</details>');
	o.push('');

	// Warnings
	const allWarnings = trace.turns.flatMap((t) => t.warnings.map((w) => `Turn ${t.index}: ${w}`));
	o.push('## Warnings');
	o.push('');
	o.push(allWarnings.length ? allWarnings.map((w) => `- ⚠ ${w}`).join('\n') : '_None._');
	o.push('');

	// Final state
	o.push('## Final game state');
	o.push('');
	o.push('```json');
	o.push(JSON.stringify({
		currentNode: trace.finalState.currentNode,
		ended: trace.finalState.ended,
		vars: trace.finalState.vars,
		counters: trace.finalState.counters,
		flags: Object.fromEntries(Object.entries(trace.finalState.flags).filter(([, v]) => v))
	}, null, 2));
	o.push('```');
	o.push('');
	o.push('---');
	o.push(RERUN);
	return o.join('\n');
}

// ---- per-run cross-scenario index -----------------------------------------

export function renderRunIndex(runId: string, traces: RunTrace[]): string {
	const o: string[] = [];
	o.push(`# Gamemaster live run — ${runId}`);
	o.push('');
	o.push('Live end-to-end playthroughs of the LLM-gamemaster scenarios against the real Mistral API.');
	o.push('Each scenario verifies that natural player prose is classified well enough to drive the');
	o.push('deterministic engine to its intended ending. See `../../README.md` for the full archive and');
	o.push('`docs/gamemaster-live-testing.md` for goals & methodology.');
	o.push('');
	o.push('| Scenario | Verdict | Ending reached | Expected | Label acc. | Report |');
	o.push('|----------|---------|----------------|----------|-----------|--------|');
	for (const t of traces) {
		const s = computeStats(t);
		o.push(
			`| ${t.title} | ${t.verdict === 'PASS' ? '✅' : '❌'} | ${t.endingId ?? '—'} | ${t.expectedEnding} | ` +
			`${pct(s.labelHits, s.labelChecked)} | [${t.scenario}.md](./${t.scenario}.md) |`
		);
	}
	o.push('');
	o.push(RERUN);
	return o.join('\n');
}

// ---- archive index (scans every run's manifest) ---------------------------

interface Manifest {
	runId: string;
	startedAtISO: string;
	scenarios: { scenario: string; title: string; verdict: string; endingId: string | null; expectedEnding: string }[];
}

function renderArchiveReadme(manifests: Manifest[]): string {
	const o: string[] = [];
	o.push('# Gamemaster live-test reports');
	o.push('');
	o.push('This folder holds **live** end-to-end test runs of the LLM-gamemaster scenarios');
	o.push('(`scenarios/*.yaml`) executed against the **real Mistral API**.');
	o.push('');
	o.push('## Why this exists');
	o.push('');
	o.push('The offline unit tests prove the deterministic engine reaches every ending when fed *hand-written*');
	o.push('classification labels. These live runs close the remaining gap: they check that **Mistral actually');
	o.push('classifies natural player prose** into the labels/targets/evidence the engine needs — i.e. that the');
	o.push('scenarios are genuinely playable, not just theoretically reachable.');
	o.push('');
	o.push('## Layout');
	o.push('');
	o.push('- `latest/` — copy of the most recent run (open `latest/index.md` first).');
	o.push('- `runs/<run-id>/` — every past run, archived (never overwritten).');
	o.push('  - `index.md` — cross-scenario summary for that run.');
	o.push('  - `<scenario>.md` — full report: prose summary, Mermaid diagram, transcript, routing detail.');
	o.push('  - `<scenario>.json` — complete structured trace (machine-readable).');
	o.push('  - `manifest.json` — one-line-per-scenario summary (drives the table below).');
	o.push('');
	o.push('## How to run');
	o.push('');
	o.push('```sh');
	o.push('MISTRAL_LIVE=1 pnpm exec vitest run tests/units/gamemaster-fullrun.live.test.ts');
	o.push('```');
	o.push('');
	o.push('Reads `MISTRAL_API_KEY` from `.env.local`. **Makes real, billed API calls.** Without');
	o.push('`MISTRAL_LIVE=1` the suite is skipped. Background & methodology: `docs/gamemaster-live-testing.md`.');
	o.push('');
	o.push('## Archive (newest first)');
	o.push('');
	o.push('| Run | Scenario | Verdict | Ending | Expected |');
	o.push('|-----|----------|---------|--------|----------|');
	const sorted = [...manifests].sort((a, b) => (a.startedAtISO < b.startedAtISO ? 1 : -1));
	for (const m of sorted) {
		for (const sc of m.scenarios) {
			o.push(
				`| [\`${m.runId}\`](./runs/${m.runId}/index.md) | ${sc.title} | ${sc.verdict === 'PASS' ? '✅' : '❌'} | ` +
				`${sc.endingId ?? '—'} | ${sc.expectedEnding} |`
			);
		}
	}
	o.push('');
	return o.join('\n');
}

// ---- orchestration: write everything for a run ----------------------------

export function writeRunReports(runId: string, traces: RunTrace[]): { runDir: string; readme: string } {
	const runsRoot = join(OUTPUT_DIR, 'runs');
	const runDir = join(runsRoot, runId);
	mkdirSync(runDir, { recursive: true });

	// per-scenario md + json
	for (const t of traces) {
		writeFileSync(join(runDir, `${t.scenario}.md`), renderScenarioMarkdown(t));
		writeFileSync(join(runDir, `${t.scenario}.json`), JSON.stringify(t, null, 2));
	}
	// per-run index
	writeFileSync(join(runDir, 'index.md'), renderRunIndex(runId, traces));
	// manifest (drives the archive index)
	const manifest: Manifest = {
		runId,
		startedAtISO: traces[0]?.startedAtISO ?? runId,
		scenarios: traces.map((t) => ({
			scenario: t.scenario, title: t.title, verdict: t.verdict, endingId: t.endingId, expectedEnding: t.expectedEnding
		}))
	};
	writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

	// refresh latest/ as a copy of this run
	const latest = join(OUTPUT_DIR, 'latest');
	if (existsSync(latest)) rmSync(latest, { recursive: true, force: true });
	cpSync(runDir, latest, { recursive: true });

	// regenerate archive README from all manifests
	const manifests: Manifest[] = [];
	for (const d of readdirSync(runsRoot)) {
		const mf = join(runsRoot, d, 'manifest.json');
		if (existsSync(mf)) {
			try { manifests.push(JSON.parse(readFileSync(mf, 'utf-8'))); } catch { /* skip */ }
		}
	}
	const readme = join(OUTPUT_DIR, 'README.md');
	writeFileSync(readme, renderArchiveReadme(manifests));

	return { runDir, readme };
}
