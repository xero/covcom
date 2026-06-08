import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
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

// COVCOM_CONFIG_DIR overrides the config location; defaults to ~/.config/covcom.
// Resolved per call rather than captured at load so the override is honoured
// even when this module is imported before the variable is set.
function configDir(): string {
	return process.env.COVCOM_CONFIG_DIR ?? join(homedir(), '.config', 'covcom');
}
function configFile(): string {
	return join(configDir(), 'config.json');
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

export function readConfig(): Config {
	if (cleanMode) return {};
	const cfg = readDiskConfig();
	if (anonMode) {
		delete cfg.server;
		delete cfg.username;
	}
	return cfg;
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
