// Playwright reporter for the file-stress sweep. It parses the `[e2e-timing]`
// lines the stress test already prints (sender classify / receiver render) and
// writes one JSON file per browser run. CI uploads that file as an artifact and
// a follow-up job merges all three engines into a cross-browser job summary.
//
// Active only when COVCOM_STRESS=1, so the regular e2e job and local
// `bunx playwright test` are unaffected (no file written).

import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MiB, parseLabelToMiB, parseTimingLine } from './timing.ts';
import type { TimingRow } from './timing.ts';

const OUT = 'web/test/e2e/results/timing.json';

export default class TimingReporter implements Reporter {
	private readonly active = process.env.COVCOM_STRESS === '1';
	private readonly rows = new Map<string, TimingRow>();

	onTestEnd(_test: TestCase, result: TestResult): void {
		if (!this.active) return;
		for (const chunk of result.stdout) {
			const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
			for (const line of text.split('\n')) {
				const t = parseTimingLine(line);
				if (!t) continue;
				const row = this.rows.get(t.label) ?? {
					browser: t.browser,
					label: t.label,
					bytes: parseLabelToMiB(t.label) * MiB,
					classifyMs: 0,
					renderMs: 0,
				};
				if (t.step.startsWith('sender classify')) {
					row.classifyMs = t.ms;
				} else if (t.step.startsWith('receiver render')) {
					// the 2-recipient case logs one render per peer; keep the slowest
					row.renderMs = Math.max(row.renderMs, t.ms);
				}
				this.rows.set(t.label, row);
			}
		}
	}

	onEnd(): void {
		if (!this.active || this.rows.size === 0) return;
		mkdirSync(dirname(OUT), { recursive: true });
		writeFileSync(OUT, JSON.stringify([...this.rows.values()], null, 2));
	}
}
