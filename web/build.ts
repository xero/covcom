// build.ts generates src/version.ts; the spa kind then spawns `vite build`.
// Exports the shared per-app contract: TARGETS and build({ kind }).
//
// Standalone usage:
//   bun build.ts               codegen only
//   bun build.ts --kind spa    codegen, then the vite production build

import { join } from 'node:path';
import { bundleVersion } from '../scripts/version.ts';
import type { Target } from '../scripts/npm.ts';

const DIR = import.meta.dir;

// The web client ships as a single-file SPA: no compiled binaries, no npm
// channel, so the target table is empty.
export const TARGETS: Target[] = [];

export async function build(opts: { kind: 'binary' | 'npm' | 'spa'; targets?: string[] }): Promise<void> {
	if (opts.kind !== 'spa') throw new Error(`web has no ${opts.kind} build`);
	await bundleVersion(join(DIR, 'src/version.ts'));
	// vite.config.ts imports src/version.ts at config-load time, so vite runs
	// as a child process spawned after codegen, never via vite's JS API. No
	// dist cleaning here: vite's emptyOutDir default already clears web/dist
	// (outDir lives inside the project root).
	const proc = Bun.spawnSync(['bunx', 'vite', 'build'], {
		cwd: DIR,
		stdout: 'inherit',
		stderr: 'inherit',
	});
	if (!proc.success) throw new Error(`vite build failed (exit ${proc.exitCode ?? 1})`);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const kindIdx = args.indexOf('--kind');
	const kind = kindIdx >= 0 ? args[kindIdx + 1] : undefined;
	try {
		if (kind) {
			await build({ kind: kind as 'binary' | 'npm' | 'spa' });
		} else {
			await bundleVersion(join(DIR, 'src/version.ts'));
		}
	} catch (e) {
		process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	}
}
