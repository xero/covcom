// Merge the per-browser timing JSON the stress reporter emits (one artifact per
// matrix job) into a single cross-browser job summary. Run by the
// e2e-stress-summary CI job after the three browser jobs finish:
//
//   bun web/test/e2e/timing-summary.ts <download-dir>
//
// Writes markdown tables to $GITHUB_STEP_SUMMARY when set, else stdout so it is
// runnable and inspectable locally. Uses only node:fs (no Bun globals, no deps).

import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MiB, parseLabelToMiB, transferTimeout } from './timing.ts';
import type { TimingRow } from './timing.ts';

const BROWSER_ORDER = ['chromium', 'firefox', 'webkit'];

function write(s: string): void {
	const f = process.env.GITHUB_STEP_SUMMARY;
	if (f) {
		appendFileSync(f, s + '\n');
	} else {
		process.stdout.write(s + '\n');
	}
}

// Recursively collect every timing.json under dir (download-artifact lays each
// artifact out in its own subdirectory).
function findTimingFiles(dir: string): string[] {
	const out: string[] = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			out.push(...findTimingFiles(p));
		} else if (e.name === 'timing.json') {
			out.push(p);
		}
	}
	return out;
}

const dir = process.argv[2] ?? 'timing-artifacts';

const rows: TimingRow[] = [];
for (const f of findTimingFiles(dir)) {
	try {
		rows.push(...(JSON.parse(readFileSync(f, 'utf8')) as TimingRow[]));
	} catch {
		// skip an unreadable or malformed artifact rather than failing the summary
	}
}

if (rows.length === 0) {
	write('## e2e stress timings\n\n_No timing data found (stress sweep produced no artifacts)._');
	process.exit(0);
}

const byLabel = new Map<string, Map<string, TimingRow>>();
const seen = new Set<string>();
for (const r of rows) {
	seen.add(r.browser);
	const m = byLabel.get(r.label) ?? new Map<string, TimingRow>();
	m.set(r.browser, r);
	byLabel.set(r.label, m);
}

const rank = (b: string): number => {
	const i = BROWSER_ORDER.indexOf(b);
	return i < 0 ? BROWSER_ORDER.length : i;
};
const cols   = [...seen].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
const labels = [...byLabel.keys()].sort((a, b) => parseLabelToMiB(a) - parseLabelToMiB(b) || a.localeCompare(b));

function table(title: string, cell: (row: TimingRow) => string): string {
	const head = `| size | ${cols.join(' | ')} |`;
	const sep  = `| ${['---', ...cols.map(() => '---')].join(' | ')} |`;
	const body = labels.map((label) => {
		const m = byLabel.get(label);
		const cells = cols.map((b) => {
			const r = m?.get(b);
			return r ? cell(r) : '';
		});
		return `| ${label} | ${cells.join(' | ')} |`;
	});
	return `### ${title}\n\n${head}\n${sep}\n${body.join('\n')}\n`;
}

const md = [
	'## e2e stress timings',
	'',
	table('Sender classify', (r) => `${(r.classifyMs / 1000).toFixed(1)}s`),
	table('Receiver render', (r) => `${(r.renderMs / 1000).toFixed(1)}s`),
	table('Throughput (s/MiB)', (r) => {
		const mib = r.bytes / MiB;
		return mib > 0 ? (r.classifyMs / 1000 / mib).toFixed(3) : '';
	}),
	table('Headroom (budget / observed)', (r) => {
		const obs = Math.max(r.classifyMs, r.renderMs);
		return obs > 0 ? `${(transferTimeout(r.bytes, r.browser) / obs).toFixed(1)}x` : '';
	}),
].join('\n');

write(md);
