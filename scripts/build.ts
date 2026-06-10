#!/usr/bin/env bun
/**
 * build.ts - root build orchestrator.
 *
 * Usage:
 *   bun scripts/build.ts <all|cli|server|web> [--kind binary|npm|spa]
 *                        [--targets all|<suffix,...>] [--codegen]
 *
 * Phase one runs codegen for every selected app: an app exporting codegen()
 * owns its full generation set (cli's covers the banner plus the version
 * module); apps without one get the shared bundleVersion() default. Phase
 * two imports each selected app's build.ts and awaits its build(). Codegen
 * precedes every build as a hard invariant: web/vite.config.ts imports
 * src/version.ts at config-load time. The npm kind runs the binary kind
 * first in the same invocation, so a staged package can never wrap a stale
 * binary. Default kinds: cli and server build binaries, web builds the spa.
 * Under the `all` selection web always builds its spa kind; --kind applies
 * to cli and server.
 */

import { join } from 'node:path';
import { bundleVersion } from './version.ts';
import { hostSuffix, type Target } from './stage.ts';

const ROOT = join(import.meta.dir, '..');
const APPS = ['cli', 'server', 'web'] as const;
type App = typeof APPS[number];

interface AppBuild {
	TARGETS: Target[];
	build: (opts: { kind: 'binary' | 'npm' | 'spa'; targets?: string[] }) => Promise<void>;
	codegen?: () => Promise<void>;
}

function die(msg: string): never {
	process.stderr.write(`build: ${msg}\n`);
	process.exit(1);
}

function usage(): never {
	process.stderr.write('usage: bun scripts/build.ts <all|cli|server|web> [--kind binary|npm|spa] [--targets all|<suffix,...>] [--codegen]\n');
	process.exit(1);
}

const args = process.argv.slice(2);
const sel = args[0];
if (!sel) usage();
const apps: App[] = sel === 'all'
	? [...APPS]
	: (APPS as readonly string[]).includes(sel) ? [sel as App] : usage();

const kindIdx = args.indexOf('--kind');
const kind = kindIdx >= 0 ? args[kindIdx + 1] : undefined;
if (kind && !['binary', 'npm', 'spa'].includes(kind)) usage();
const tIdx = args.indexOf('--targets');
const targets = tIdx >= 0 ? args[tIdx + 1].split(',') : undefined;

// Phase one: codegen for every selected app, before any build.
const loaded: [App, AppBuild][] = [];
for (const app of apps) {
	const mod = await import(join(ROOT, app, 'build.ts')) as AppBuild;
	loaded.push([app, mod]);
	await (mod.codegen ? mod.codegen() : bundleVersion(join(ROOT, app, 'src/version.ts')));
}
if (args.includes('--codegen')) process.exit(0);

// Phase two: dispatch to each app's exported build().
for (const [app, mod] of loaded) {
	if (app === 'web') {
		if (sel === 'web' && kind && kind !== 'spa') die(`web has no ${kind} build`);
		await mod.build({ kind: 'spa' });
		continue;
	}
	if (kind === 'spa') die(`${app} has no spa build`);
	if (kind === 'npm') {
		const suffixes = targets ?? [hostSuffix(mod.TARGETS)];
		await mod.build({ kind: 'binary', targets: suffixes });
		await mod.build({ kind: 'npm', targets: suffixes });
	} else {
		await mod.build({ kind: 'binary', targets });
	}
}
