import { createScreen } from './tui/screen.js';
import { readConfig, setCleanMode, setAnonMode } from './config.js';
import { initCrypto } from '@covcom/lib';
import { mount } from './state.js';
import { doCleanup } from './lifecycle.js';

process.title = 'covcom';

// parse CLI args: covcom [--clean] [--anon] [--join /path/to/invite.room]
const args     = process.argv.slice(2);
const clean    = args.includes('--clean');
const anon     = args.includes('--anon');
const joinIdx  = args.indexOf('--join');
const joinNext = joinIdx >= 0 ? args[joinIdx + 1] : undefined;
// guard a missing value (e.g. `--join --clean`) so a flag isn't read as a path
const joinArg  = joinNext && !joinNext.startsWith('--') ? joinNext : undefined;

// --clean ignores ~/.config/covcom/config.json entirely (no read, no write).
// --anon skips only server/username; other settings read/write normally.
setCleanMode(clean);
setAnonMode(anon);

process.on('SIGTERM', () => {
	doCleanup(); process.exit(0);
});
process.on('SIGINT',  () => {
	doCleanup(); process.exit(0);
});
process.on('exit',    () => {
	doCleanup();
});
process.on('unhandledRejection', (err: unknown) => {
	const msg = err instanceof Error ? err.message : String(err);
	process.stderr.write(`[unhandled rejection] ${msg}\n`);
});

async function main(): Promise<void> {
	await initCrypto();
	const screen = createScreen();
	const config = readConfig();
	mount(screen, config, joinArg);
}

process.stdin.resume();  // keep Bun alive while TUI runs

main().catch((e) => {
	process.stderr.write(`Fatal: ${e}\n`);
	process.exit(1);
});
