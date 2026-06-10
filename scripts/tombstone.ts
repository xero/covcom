#!/usr/bin/env bun
/**
 * tombstone.ts - release version tombstoning for covcom, run with Bun.
 *
 * Usage:
 *   bun scripts/tombstone.ts --versionbump <major|minor|patch> <reason>
 *
 * The bump itself is a single `npm version --no-git-tag-version` call; the
 * script exists for the tombstone work: in SECURITY.md and docker/DOCKERHUB.md
 * it demotes the current "Latest version" row to deprecated (stamping <reason>
 * as its new reason) and inserts a fresh "Latest version" supported row for
 * the just-bumped version. It performs no git actions and leaves the working
 * tree dirty for manual review.
 */

import { join } from 'node:path';

// All file access is anchored to the repo root so the script behaves the same
// from any cwd.
const ROOT = join(import.meta.dir, '..');
const REPO_FILES = [join(ROOT, 'SECURITY.md'), join(ROOT, 'docker/DOCKERHUB.md')];
const BUMP_TYPES = ['major', 'minor', 'patch'];
const SUPPORTED_MARK = '✓ supported';
// Matches the displayed version in a table cell: `[v3.0.1]...` or `[3.0.0]...`.
const VERSION_RE = /\[v?(\d+\.\d+\.\d+)\]/;

function die(msg: string, code = 1): never {
	process.stderr.write(`tombstone: ${msg}\n`);
	process.exit(code);
}

function usage(): never {
	process.stderr.write('usage: bun scripts/tombstone.ts --versionbump <major|minor|patch> <reason>\n');
	process.exit(1);
}

/** The version of the current `✓ supported` row, or '' if none is parseable. */
function parseSupportedVersion(content: string): string {
	const line = content.split('\n').find((l) => l.includes(SUPPORTED_MARK));
	const match = line?.match(VERSION_RE);
	return match ? match[1] : '';
}

/**
 * Demote the current supported row and prepend a new supported row for
 * `newVersion`. The row is located by its `✓ supported` cell; the new row is
 * cloned from the outgoing one so column padding and the file's own version
 * display style (v-prefixed vs bare docker tag) carry over untouched. Version
 * links are self-contained inline URLs into CHANGELOG.md, so no footer
 * reference defs are involved.
 */
function bumpVersionTable(content: string, oldVersion: string, newVersion: string, reason: string): string {
	const lines = content.split('\n');
	const i = lines.findIndex((l) => l.includes(SUPPORTED_MARK));
	const supported = lines[i];
	// CHANGELOG anchors strip the dots: 3.0.1 -> v301, matching #v300/#v100.
	const oldSlug = `v${oldVersion.replace(/\./g, '')}`;
	const newSlug = `v${newVersion.replace(/\./g, '')}`;
	const fresh = supported
		.replace(oldVersion, newVersion)
		.replace(oldSlug, newSlug);
	// Consume one trailing space so `✗ deprecated` (a char longer than
	// `supported`) keeps the Status column aligned with the existing rows.
	const demoted = supported
		.replace('✓ supported ', '✗ deprecated')
		.replace('Latest version', reason);
	lines.splice(i, 1, fresh, demoted);
	return lines.join('\n');
}

async function readVersion(): Promise<string> {
	const pkg = JSON.parse(await Bun.file(join(ROOT, 'package.json')).text());
	return pkg.version;
}

async function versionbump(bumpType: string, reason: string): Promise<void> {
	if (!BUMP_TYPES.includes(bumpType)) {
		usage();
	}
	if (!reason || !reason.trim()) {
		usage();
	}

	// Pre-flight: every doc must carry a supported row whose version already
	// matches package.json. This catches an out-of-sync repo before we bump
	// anything, rather than emitting a degenerate row pair afterward.
	const oldVersion = await readVersion();
	const docs = await Promise.all(
		REPO_FILES.map(async (file) => ({ file, text: await Bun.file(file).text() })),
	);
	for (const { file, text } of docs) {
		const supported = parseSupportedVersion(text);
		if (!supported) {
			die(`${file}: no parseable "${SUPPORTED_MARK}" row found; refusing to bump`);
		}
		if (supported !== oldVersion) {
			die(`${file}: supported row is ${supported} but package.json is ${oldVersion}; sync them before bumping`);
		}
	}

	const result = Bun.spawnSync(
		['npm', 'version', bumpType, '--no-git-tag-version'],
		{ cwd: ROOT, stdout: 'inherit', stderr: 'inherit' },
	);
	if (!result.success) {
		die('npm version failed', result.exitCode ?? 1);
	}
	const newVersion = await readVersion();

	for (const { file, text } of docs) {
		await Bun.write(file, bumpVersionTable(text, oldVersion, newVersion, reason));
		process.stdout.write(`tombstone: updated ${file}\n`);
	}
	process.stdout.write(`tombstone: bumped ${oldVersion} -> ${newVersion} (working tree left dirty, no git actions taken)\n`);
}

export {};

const [command, ...rest] = process.argv.slice(2);

switch (command) {
case '--versionbump':
	await versionbump(rest[0], rest[1]);
	break;
default:
	usage();
}
