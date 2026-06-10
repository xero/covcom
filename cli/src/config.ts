import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { Theme } from './tui/screen.js';

export interface Config {
	server?:     string
	username?:   string
	copyCmd?:    string
	theme?:      Partial<Theme>
	showSystem?: boolean
	sidebar?:    { width?: number }
	icons?:      { send?: string; attach?: string; ratchet?: string; keys?: string; events?: string; verify?: string; escape?: string }
}

export const SIDEBAR_WIDTH_DEFAULT = 30;
export const SIDEBAR_WIDTH_MIN     = 10;
export const SIDEBAR_WIDTH_MAX     = 70;
export const SIDEBAR_WIDTH_STEP    = 5;
export const SIDEBAR_MIN_COLS      = 80;

export function readSidebarWidth(cfg: Config): number {
	const p = cfg.sidebar?.width;
	if (typeof p !== 'number' || !Number.isFinite(p)) return SIDEBAR_WIDTH_DEFAULT;
	return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.round(p)));
}

export function writeSidebarWidth(width: number): void {
	const clamped = Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.round(width)));
	const cfg     = readConfig();
	writeConfig({ ...cfg, sidebar: { ...(cfg.sidebar ?? {}), width: clamped } });
}

// Explicit config-file path from the --config flag; set once at startup. Takes
// precedence over the XDG resolution below.
let configPathOverride: string | undefined;

export function setConfigPath(path: string | undefined): void {
	configPathOverride = path;
}

// Resolve the config file path. Precedence:
//   1. --config <path> (used verbatim)
//   2. $XDG_CONFIG_HOME/covcom/config.json
//   3. ~/.config/covcom/config.json  (the XDG default base)
// Resolved per call rather than captured at load so an override or env set after
// this module is imported is still honoured.
function configFile(): string {
	if (configPathOverride) return configPathOverride;
	const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
	return join(base, 'covcom', 'config.json');
}
function configDir(): string {
	return dirname(configFile());
}

// clean mode; the config file is ignored entirely: never read, never written.
// set once at startup via the --clean CLI flag.
let cleanMode = false;

// anon mode; only server/username are skipped: they are neither read (no login
// prefill) nor written (the on-disk values are left untouched). all other
// settings still read and persist as normal. set via --anon.
let anonMode = false;

export function setCleanMode(on: boolean): void {
	cleanMode = on;
}

export function setAnonMode(on: boolean): void {
	anonMode = on;
}

// raw, unfiltered read of the on-disk config
function readDiskConfig(): Config {
	try {
		return JSON.parse(readFileSync(configFile(), 'utf8')) as Config;
	} catch {
		return {};
	}
}

const ICON_KEYS = ['send', 'attach', 'ratchet', 'keys', 'events', 'verify', 'escape'] as const;

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Validate the known top-level fields, dropping any that are present with the
// wrong type so a malformed-but-parseable config can never crash a consumer.
// theme is validated separately (loadTheme/themeErrors), and unknown keys (e.g.
// `_comment` keys) pass through untouched, so a read-merge save never clobbers a
// user's colors or comments. Returns the dropped keys for startup reporting.
function sanitizeConfig(raw: Config): { config: Config; badFields: string[] } {
	const cfg: Config = { ...raw };
	const badFields: string[] = [];
	const isStr = (v: unknown): boolean => typeof v === 'string';
	if ('server' in cfg && !isStr(cfg.server)) {
		delete cfg.server;
		badFields.push('server');
	}
	if ('username' in cfg && !isStr(cfg.username)) {
		delete cfg.username;
		badFields.push('username');
	}
	if ('copyCmd' in cfg && !isStr(cfg.copyCmd)) {
		delete cfg.copyCmd;
		badFields.push('copyCmd');
	}
	if ('showSystem' in cfg && typeof cfg.showSystem !== 'boolean') {
		delete cfg.showSystem;
		badFields.push('showSystem');
	}
	// width range is clamped on read (readSidebarWidth); here we only guard shape.
	if ('sidebar' in cfg && !isObject(cfg.sidebar)) {
		delete cfg.sidebar;
		badFields.push('sidebar');
	}
	if ('icons' in cfg && !isObject(cfg.icons)) {
		delete cfg.icons;
		badFields.push('icons');
	} else if (isObject(cfg.icons)) {
		// Rebuild rather than delete in place: keep every valid known icon plus
		// all unknown/comment keys, and drop only the wrong-typed known ones.
		const src   = cfg.icons as Record<string, unknown>;
		const icons: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(src)) {
			if ((ICON_KEYS as readonly string[]).includes(k) && !isStr(v)) {
				badFields.push(`icons.${k}`);
				continue;
			}
			icons[k] = v;
		}
		cfg.icons = icons as Config['icons'];
	}
	return { config: cfg, badFields };
}

export function readConfig(): Config {
	if (cleanMode) return {};
	const cfg = readDiskConfig();
	if (anonMode) {
		delete cfg.server;
		delete cfg.username;
	}
	return sanitizeConfig(cfg).config;
}

// Startup read that distinguishes a missing config file (normal) from one that
// is present but fails to parse (an error worth surfacing). readConfig stays the
// silent {}-on-failure path for the many in-app re-reads.
export function readConfigChecked(): { config: Config; parseFailed: boolean; badFields: string[] } {
	if (cleanMode) return { config: {}, parseFailed: false, badFields: [] };
	let config: Config = {};
	let parseFailed = false;
	try {
		config = JSON.parse(readFileSync(configFile(), 'utf8')) as Config;
	} catch (e) {
		// a missing file is normal; anything else means the file is broken
		if ((e as NodeJS.ErrnoException).code !== 'ENOENT') parseFailed = true;
	}
	if (anonMode) {
		delete config.server;
		delete config.username;
	}
	const { config: sanitized, badFields } = sanitizeConfig(config);
	return { config: sanitized, parseFailed, badFields };
}

export function writeConfig(cfg: Config): void {
	if (cleanMode) return;
	let out = cfg;
	if (anonMode) {
		// persist everything except server/username; keep whatever is on
		// disk for those two so an anon run never reads or rewrites them.
		const disk = readDiskConfig();
		out = { ...disk, ...cfg, server: disk.server, username: disk.username };
	}
	try {
		mkdirSync(configDir(), { recursive: true });
		writeFileSync(configFile(), JSON.stringify(out, null, 2));
	} catch {
		// non-fatal
	}
}
