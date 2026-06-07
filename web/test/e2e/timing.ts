// Shared timing model for the file-stress sweep. Pure, no @playwright/test
// import, so both the stress test (which sets its transfer budget) and the
// CI summary script (which reports headroom against that budget) read the same
// numbers from one place; the two cannot drift apart.

export const MiB = 1024 * 1024;

// Sender classify dominates each transfer and scales linearly with size; the
// [e2e-timing] CI logs put the clean-run worst case near firefox ~0.35,
// chromium ~0.15, webkit ~0.12 s/MiB. These ms/MiB rates are roughly double
// that, so every size gets ~2x headroom on the same engine. The doubling also
// covers shared-runner contention, which clean local samples never see.
//
// firefox gets the largest rate because Playwright's bundled Firefox runs WASM
// ~20x slower than the Firefox users install (its optimizing JIT tier does not
// engage), so the leviathan-crypto seal/sign kernels are the bottleneck only
// for e2e. Stock Firefox benches on par with Chromium and WebKit. This budget is a
// Playwright-Firefox allowance, NOT evidence that Firefox is slow for users; do
// not "optimize" covcom or leviathan-crypto for it.
export const MS_PER_MIB: Record<string, number> = { firefox: 700, chromium: 300, webkit: 250 };

// Per-engine transfer budget for a given size, with a 60s floor so small files
// (dominated by fixed setup cost, not throughput) keep a sane ceiling.
export function transferTimeout(bytes: number, browserName: string): number {
	return Math.max(60_000, Math.ceil(bytes / MiB) * (MS_PER_MIB[browserName] ?? 300));
}

// One parsed `[e2e-timing]` console line. `label` is the size group
// ("64 MiB", "180 MiB 2-recipient"); `step` is "sender classify",
// "receiver render", or "receiver render <who>" for the multi-recipient case.
export interface ParsedTiming {
	browser: string;
	label: string;
	step: string;
	ms: number;
}

// Not anchored to start-of-line: Playwright's list reporter can fuse a progress
// dot onto the front of a captured line (`·[e2e-timing] ...`) in the raw logs.
const TIMING_RE = /\[e2e-timing\] (\S+) (.+) (sender classify|receiver render(?: \S+)?): (\d+)ms/;

export function parseTimingLine(line: string): ParsedTiming | null {
	const m = line.match(TIMING_RE);
	if (!m) return null;
	return { browser: m[1], label: m[2], step: m[3], ms: Number(m[4]) };
}

// "180 MiB" -> 180, "180 MiB 2-recipient" -> 180, "64 MiB" -> 64. Reads the
// leading integer and first unit token; GiB scales to MiB (no GiB sizes run
// today, but the conversion stays so a larger sweep parses unchanged). Returns 0
// if the label has no recognizable size prefix.
export function parseLabelToMiB(label: string): number {
	const m = label.match(/^(\d+)\s*(GiB|MiB)/);
	if (!m) return 0;
	const n = Number(m[1]);
	return m[2] === 'GiB' ? n * 1024 : n;
}

// One merged size row for a single browser: the two timeStep measurements plus
// the byte size they were taken at.
export interface TimingRow {
	browser: string;
	label: string;
	bytes: number;
	classifyMs: number;
	renderMs: number;
}
