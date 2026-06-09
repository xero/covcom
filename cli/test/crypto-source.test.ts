import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// Architectural guard: @covcom/lib is the single source of leviathan-crypto, so
// the cli must reach it only transitively through the workspace package, never
// by naming it directly. A direct cli dependency lets the pinned version drift
// from lib's, which re-splits the two into separate WASM instances and revives
// the 0x01-vs-0x03 class of protocol drift this whole manifest exists to prevent.
// The compiled-binary runtime path is covered separately by the cross-client test.
const CLI_ROOT = join(import.meta.dir, '..');

describe('crypto is sourced through @covcom/lib only', () => {
	test('cli/package.json does not declare leviathan-crypto', () => {
		const pkg = JSON.parse(readFileSync(join(CLI_ROOT, 'package.json'), 'utf8'));
		expect(pkg.dependencies?.['leviathan-crypto']).toBeUndefined();
		expect(pkg.devDependencies?.['leviathan-crypto']).toBeUndefined();
	});

	test('no cli source imports leviathan-crypto directly', () => {
		const srcDir = join(CLI_ROOT, 'src');
		const tsFiles = readdirSync(srcDir, { recursive: true })
			.filter((f): f is string => typeof f === 'string' && f.endsWith('.ts'));
		const offenders = tsFiles.filter(f =>
			/from\s+['"]leviathan-crypto/.test(readFileSync(join(srcDir, f), 'utf8')),
		);
		expect(offenders).toEqual([]);
	});
});
