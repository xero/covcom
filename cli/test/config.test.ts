import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Config } from '../src/config.ts';

// config.ts reads COVCOM_CONFIG_DIR at import time, so point it at a throwaway
// temp dir before the dynamic import below. This keeps every read/write off the
// real ~/.config/covcom/config.json and is order-independent across the suite
// (unlike mocking the builtin os/fs path, which Bun does not reliably intercept).
const dir         = mkdtempSync(join(tmpdir(), 'covcom-config-'));
const CONFIG_FILE = join(dir, 'config.json');
process.env.COVCOM_CONFIG_DIR = dir;

const { readConfig, writeConfig, setCleanMode, setAnonMode } = await import('../src/config.ts');

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function seed(cfg: Config): void {
	writeFileSync(CONFIG_FILE, JSON.stringify(cfg));
}

function disk(): Config | undefined {
	return existsSync(CONFIG_FILE) ? (JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Config) : undefined;
}

beforeEach(() => {
	setCleanMode(false);
	setAnonMode(false);
	rmSync(CONFIG_FILE, { force: true });
});

describe('default (no paranoia flags)', () => {
	test('readConfig returns the full on-disk config including credentials', () => {
		const stored = { server: 'chat.example.com', username: 'me', copyCmd: 'pbcopy', showSystem: true };
		seed(stored);
		expect(readConfig()).toEqual(stored);
	});

	test('readConfig returns {} when no config file exists', () => {
		expect(readConfig()).toEqual({});
	});

	test('writeConfig persists exactly what it is given', () => {
		const cfg = { server: 'host', username: 'bob', sidebar: { width: 40 } };
		writeConfig(cfg);
		expect(disk()).toEqual(cfg);
	});
});

describe('--clean', () => {
	test('readConfig returns {} even when the disk holds a populated config', () => {
		seed({ server: 'host', username: 'bob', copyCmd: 'pbcopy' });
		setCleanMode(true);
		expect(readConfig()).toEqual({});
	});

	test('writeConfig leaves an existing config file untouched', () => {
		const stored = { server: 'host', username: 'bob' };
		seed(stored);
		setCleanMode(true);
		writeConfig({ server: 'overwritten', username: 'hacked', copyCmd: 'xclip' });
		expect(disk()).toEqual(stored);
	});

	test('writeConfig does not create a config file when none exists', () => {
		setCleanMode(true);
		writeConfig({ server: 'host', username: 'bob' });
		expect(existsSync(CONFIG_FILE)).toBe(false);
	});
});

describe('--anon', () => {
	test('readConfig strips server/username but keeps every other setting', () => {
		seed({
			server: 'host',
			username: 'bob',
			copyCmd: 'pbcopy',
			showSystem: true,
			sidebar: { width: 42 },
			icons: { send: '>' },
			theme: { fg: { type: 'hex', value: '#00ffff' } },
		});
		setAnonMode(true);
		expect(readConfig()).toEqual({
			copyCmd: 'pbcopy',
			showSystem: true,
			sidebar: { width: 42 },
			icons: { send: '>' },
			theme: { fg: { type: 'hex', value: '#00ffff' } },
		});
	});

	test('readConfig returns {} when no config file exists', () => {
		setAnonMode(true);
		expect(readConfig()).toEqual({});
	});

	test('writeConfig preserves on-disk credentials while updating other fields', () => {
		seed({ server: 'real-host', username: 'me', copyCmd: 'old' });
		setAnonMode(true);
		writeConfig({ server: 'EVIL', username: 'EVIL', copyCmd: 'new', showSystem: true });
		expect(disk()).toEqual({ server: 'real-host', username: 'me', copyCmd: 'new', showSystem: true });
	});

	test('writeConfig never writes credentials when the disk has none', () => {
		seed({ copyCmd: 'old' });
		setAnonMode(true);
		writeConfig({ server: 'EVIL', username: 'EVIL', copyCmd: 'new' });
		const out = disk();
		expect(out).toEqual({ copyCmd: 'new' });
		expect('server' in (out ?? {})).toBe(false);
		expect('username' in (out ?? {})).toBe(false);
	});
});

describe('precedence (--clean and --anon together)', () => {
	test('clean wins: readConfig returns {} and writeConfig is a no-op', () => {
		const stored = { server: 'host', username: 'bob', copyCmd: 'pbcopy' };
		seed(stored);
		setCleanMode(true);
		setAnonMode(true);
		expect(readConfig()).toEqual({});
		writeConfig({ copyCmd: 'changed' });
		expect(disk()).toEqual(stored);
	});
});
