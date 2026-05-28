import { createScreen } from './tui/screen.js';
import { readConfig } from './config.js';
import { initCrypto } from './init.js';
import { mount } from './state.js';
import { doCleanup } from './lifecycle.js';

process.title = 'covcom';

// Parse CLI args: covcom join /path/to/invite.room
const args    = process.argv.slice(2);
const joinArg = args[0] === 'join' ? args[1] : undefined;

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

process.stdin.resume();   // keep Bun alive while TUI runs

main().catch((e) => {
	process.stderr.write(`Fatal: ${e}\n`);
	process.exit(1);
});
