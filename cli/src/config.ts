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
	icons?:      { send?: string; attach?: string; ratchet?: string; keys?: string }
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

const CONFIG_DIR  = join(homedir(), '.config', 'covcom');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export function readConfig(): Config {
	try {
		return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Config;
	} catch {
		return {};
	}
}

export function writeConfig(cfg: Config): void {
	try {
		mkdirSync(CONFIG_DIR, { recursive: true });
		writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
	} catch {
		// Non-fatal
	}
}
