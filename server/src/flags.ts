import { parseArgs } from 'node:util';
import type { ServerConfig } from './index.ts';

// Pure flag parser for the standalone server. No process.exit, no env reads, no
// writes: the caller (the import.meta.main guard in index.ts) decides what to do
// with the result. Env vars keep their forgiving guards in startServer(); flags
// validate strictly so an operator typing them gets loud failure.

const options = {
	port: { type: 'string', short: 'p' },
	host: { type: 'string' },
	'max-room-size': { type: 'string' },
	'admin-token': { type: 'string' },
	'room-ttl': { type: 'string' },
	help: { type: 'boolean', short: 'h' },
	version: { type: 'boolean', short: 'v' },
} as const;

export const USAGE = `covcom server - post-quantum E2EE chat relay

Usage: covcom-server [options]

Options:
  -p, --port <n>           Port to listen on (env PORT, default 1337)
      --host <addr>        Interface to bind (env HOST, default 127.0.0.1)
      --max-room-size <n>  Max participants per room, 0 = unlimited (env MAX_ROOM_SIZE, default 20)
      --admin-token <s>    Token required to create rooms (env ADMIN_TOKEN, default unset)
      --room-ttl <n>       Hours before an empty room is pruned, 0 = never (env ROOM_TTL, default 24)
  -h, --help               Show this help and exit
  -v, --version            Print the version and protocol byte and exit

Precedence: flag > environment variable > default.

Warning: --admin-token is visible in process listings (ps) and shell history.
Prefer the ADMIN_TOKEN environment variable for secrets.`;

// Strict integer parse. Rejects '', 'abc', '12abc', '1.5'. A leading '-' is
// admitted so '-5' parses to -5 rather than null; the caller's n < 0 check then
// rejects it, yielding the precise "invalid value for --port: -5" usage error.
function toNum(raw: string): number | null {
	if (!/^-?\d+$/.test(raw)) return null;
	return Number(raw);
}

export interface ParseResult {
	config:   ServerConfig
	help?:    string
	error?:   string
	version?: true
}

export function parseFlags(argv: string[]): ParseResult {
	let values;
	try {
		({ values } = parseArgs({ args: argv, options, strict: true, allowPositionals: false }));
	} catch (e) {
		return { config: {}, error: `${(e as Error).message}\n\n${USAGE}` };
	}

	// A marker, not the text to print: the parser stays pure, so the entry
	// point owns the baked-in version constants and the printing.
	if (values.version) return { config: {}, version: true };
	if (values.help) return { config: {}, help: USAGE };

	const fail = (flag: string, raw: string): ParseResult =>
		({ config: {}, error: `invalid value for ${flag}: ${raw}\n\n${USAGE}` });

	// Only set keys the user actually passed: startServer() uses 'adminToken' in
	// config to decide whether the flag overrides the env token, so an unset key
	// must be absent, never adminToken: undefined.
	const config: ServerConfig = {};

	if (values.port !== undefined) {
		const n = toNum(values.port);
		if (n === null || n < 0 || n > 65535) return fail('--port', values.port);
		config.port = n;
	}
	if (values.host !== undefined) config.hostname = values.host;
	if (values['max-room-size'] !== undefined) {
		const n = toNum(values['max-room-size']);
		if (n === null || n < 0) return fail('--max-room-size', values['max-room-size']);
		config.maxRoomSize = n;
	}
	if (values['admin-token'] !== undefined) config.adminToken = values['admin-token'];
	if (values['room-ttl'] !== undefined) {
		const n = toNum(values['room-ttl']);
		if (n === null || n < 0) return fail('--room-ttl', values['room-ttl']);
		config.roomTtl = n;
	}

	return { config };
}
