import { createScreen } from './tui/screen.js';
import { readConfigChecked, setCleanMode, setAnonMode, setConfigPath } from './config.js';
import { initCrypto } from '@covcom/lib';
import { mount } from './state.js';
import { doCleanup } from './lifecycle.js';
import { parseArgs } from './args.js';
import { VERSION, PROTOCOL_HEX } from './version.js';
import { BANNER } from './tui/banner.js';

process.title = 'covcom';

const HELP = `Usage: covcom [OPTION]...

Covert communications tool for private group conversations.

Options:
  -h, --help             display this message and exit
  -v, --version          output version and protocol information and exit
  -c, --config=PATH      override default configuration file
                           (default: $XDG_CONFIG_HOME/covcom/config.json)
  -j, --join=PATH        parse and prefill a .room invite file at startup
  -x, --clean            completely disable configuration file persistence
                           (neither reads nor writes to disk)
  -a, --anon             narrow variant of --clean that avoids reading and
                           writing the server and username config fields

Report bugs to: https://github.com/xero/covcom
`;

const opts = parseArgs(process.argv.slice(2));

// --help prints the banner and usage, then exits before any TUI setup.
if (opts.help) {
	process.stdout.write(`${BANNER}\n${HELP}`);
	process.exit(0);
}

// --version prints the baked-in version facts and exits before any TUI setup.
if (opts.version) {
	process.stdout.write(`COVCOM v${VERSION}\nprotocol ${PROTOCOL_HEX}\n`);
	process.exit(0);
}

// --config overrides the config file path (else $XDG_CONFIG_HOME, else ~/.config).
// --clean ignores the config file entirely (no read, no write).
// --anon skips only server/username; other settings read/write normally.
setConfigPath(opts.config);
setCleanMode(opts.clean);
setAnonMode(opts.anon);

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
	const { config, parseFailed, badFields } = readConfigChecked();
	mount(screen, config, opts.join, parseFailed, badFields);
}

process.stdin.resume();  // keep Bun alive while TUI runs

main().catch((e) => {
	process.stderr.write(`Fatal: ${e}\n`);
	process.exit(1);
});
