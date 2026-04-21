import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { Theme } from './tui/screen.js';

export interface Config {
	server?:         string
	username?:       string
	copyCmd?:        string
	theme?:          Partial<Theme>
	systemMessages?: boolean
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
