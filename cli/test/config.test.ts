import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Config } from '../src/config.ts';

// Point config.ts at a throwaway file via setConfigPath (the --config override),
// which wins over $XDG_CONFIG_HOME and keeps every read/write off the real
// ~/.config/covcom/config.json. Order-independent across the suite (unlike
// mocking the builtin os/fs path, which Bun does not reliably intercept).
const dir         = mkdtempSync(join(tmpdir(), 'covcom-config-'));
const CONFIG_FILE = join(dir, 'config.json');

const { readConfig, readConfigChecked, writeConfig, setCleanMode, setAnonMode, setConfigPath } = await import('../src/config.ts');
setConfigPath(CONFIG_FILE);

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

describe('readConfigChecked', () => {
	test('valid file: returns config, parseFailed false, no bad fields', () => {
		const stored = { server: 'host', username: 'me' };
		seed(stored);
		expect(readConfigChecked()).toEqual({ config: stored, parseFailed: false, badFields: [] });
	});

	test('missing file is not an error', () => {
		expect(readConfigChecked()).toEqual({ config: {}, parseFailed: false, badFields: [] });
	});

	test('malformed file: empty config, parseFailed true', () => {
		writeFileSync(CONFIG_FILE, '{ not valid json');
		expect(readConfigChecked()).toEqual({ config: {}, parseFailed: true, badFields: [] });
	});

	test('--clean ignores the file with no error', () => {
		writeFileSync(CONFIG_FILE, '{ not valid json');
		setCleanMode(true);
		expect(readConfigChecked()).toEqual({ config: {}, parseFailed: false, badFields: [] });
	});
});

describe('sanitizeConfig (top-level field validation)', () => {
	test('readConfig drops wrong-typed fields and keeps valid + unknown keys', () => {
		seed({
			server: 123,
			username: 'me',
			copyCmd: 7,
			showSystem: 'yes',
			sidebar: 'wide',
			icons: { send: 5, keys: 'x' },
			_comment: 'kept',
		} as unknown as Config);
		expect(readConfig()).toEqual({
			username: 'me',
			icons: { keys: 'x' },
			_comment: 'kept',
		} as unknown as Config);
	});

	test('readConfigChecked names every dropped field', () => {
		seed({
			server: 123,
			copyCmd: 7,
			showSystem: 'yes',
			icons: { send: 5 },
		} as unknown as Config);
		const { config, parseFailed, badFields } = readConfigChecked();
		expect(parseFailed).toBe(false);
		expect(config).toEqual({ icons: {} } as unknown as Config);
		expect(badFields.sort()).toEqual(['copyCmd', 'icons.send', 'server', 'showSystem']);
	});

	test('non-object icons is dropped wholesale', () => {
		seed({ icons: 'nope' } as unknown as Config);
		expect(readConfigChecked().badFields).toEqual(['icons']);
		expect(readConfig()).toEqual({});
	});

	test('a fully valid config reports no bad fields', () => {
		const stored = { server: 'h', username: 'me', copyCmd: 'pbcopy', showSystem: false, sidebar: { width: 40 }, icons: { send: '>' } };
		seed(stored);
		expect(readConfigChecked().badFields).toEqual([]);
		expect(readConfig()).toEqual(stored);
	});
});

describe('config file resolution', () => {
	// These exercise the XDG path, so they take setConfigPath off the throwaway
	// file for the duration and restore it afterward.
	afterAll(() => setConfigPath(CONFIG_FILE));

	test('$XDG_CONFIG_HOME lands the file at <xdg>/covcom/config.json', () => {
		const xdg = mkdtempSync(join(tmpdir(), 'covcom-xdg-'));
		const prevXdg = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = xdg;
		setConfigPath(undefined);
		try {
			writeConfig({ server: 'via-xdg' });
			expect(existsSync(join(xdg, 'covcom', 'config.json'))).toBe(true);
		} finally {
			if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = prevXdg;
			rmSync(xdg, { recursive: true, force: true });
		}
	});

	test('--config path wins over $XDG_CONFIG_HOME', () => {
		const xdg = mkdtempSync(join(tmpdir(), 'covcom-xdg-'));
		const override = join(dir, 'override.json');
		const prevXdg = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = xdg;
		setConfigPath(override);
		try {
			writeConfig({ server: 'via-override' });
			expect(existsSync(override)).toBe(true);
			expect(existsSync(join(xdg, 'covcom', 'config.json'))).toBe(false);
		} finally {
			if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = prevXdg;
			rmSync(override, { force: true });
			rmSync(xdg, { recursive: true, force: true });
		}
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
