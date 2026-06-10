import { afterAll, describe, expect, test } from 'bun:test';
import { parseFlags, USAGE } from '../src/flags.ts';
import { startServer } from '../src/index.ts';
import { pickPort, spawnServer as spawnEntry, waitForHealth } from './util.ts';

// Pure-parser unit tests plus precedence (in-process) and subprocess smoke
// tests. The parser never exits or reads env; the entry point owns that.
// The subprocess tests run against `bun run src/index.ts` or the compiled
// binary, selected by COVCOM_SERVER_BIN (see util.ts).

describe('parseFlags: each flag maps to its config key', () => {
	test('--port / -p', () => {
		expect(parseFlags(['--port', '8080']).config.port).toBe(8080);
		expect(parseFlags(['-p', '8080']).config.port).toBe(8080);
	});
	test('--host', () => {
		expect(parseFlags(['--host', '0.0.0.0']).config.hostname).toBe('0.0.0.0');
	});
	test('--max-room-size', () => {
		expect(parseFlags(['--max-room-size', '5']).config.maxRoomSize).toBe(5);
	});
	test('--admin-token', () => {
		expect(parseFlags(['--admin-token', 'sekret']).config.adminToken).toBe('sekret');
	});
	test('--room-ttl', () => {
		expect(parseFlags(['--room-ttl', '48']).config.roomTtl).toBe(48);
	});
});

describe('parseFlags: unset flags leave keys absent', () => {
	test('empty argv yields an empty config (keys absent, not undefined)', () => {
		const { config } = parseFlags([]);
		expect('port' in config).toBe(false);
		expect('hostname' in config).toBe(false);
		expect('maxRoomSize' in config).toBe(false);
		expect('adminToken' in config).toBe(false);
		expect('roomTtl' in config).toBe(false);
	});
	test('a partial argv only sets the keys passed', () => {
		const { config } = parseFlags(['--port', '1234']);
		expect('port' in config).toBe(true);
		expect('adminToken' in config).toBe(false);
	});
});

describe('parseFlags: help', () => {
	test('--help and -h set help to the usage text', () => {
		expect(parseFlags(['--help']).help).toBe(USAGE);
		expect(parseFlags(['-h']).help).toBe(USAGE);
	});
	test('usage mentions every flag', () => {
		for (const flag of ['--port', '--host', '--max-room-size', '--admin-token', '--room-ttl', '--help', '--version'])
			expect(USAGE).toContain(flag);
	});
	test('usage mentions every env var name', () => {
		for (const env of ['PORT', 'HOST', 'MAX_ROOM_SIZE', 'ADMIN_TOKEN', 'ROOM_TTL'])
			expect(USAGE).toContain(env);
	});
	test('usage states the precedence order', () => {
		expect(USAGE).toContain('flag > environment variable > default');
	});
});

describe('parseFlags: version', () => {
	test('--version and -v set the marker, nothing else', () => {
		for (const argv of [['--version'], ['-v']]) {
			const r = parseFlags(argv);
			expect(r.version).toBe(true);
			expect(r.help).toBeUndefined();
			expect(r.error).toBeUndefined();
		}
	});
	test('--version wins when --help is also passed (matches the entry point order)', () => {
		const r = parseFlags(['--help', '--version']);
		expect(r.version).toBe(true);
		expect(r.help).toBeUndefined();
	});
});

describe('parseFlags: strict validation', () => {
	test('unknown flag is an error carrying the usage text', () => {
		const { error } = parseFlags(['--nope']);
		expect(error).toBeDefined();
		expect(error).toContain(USAGE);
	});
	test('non-numeric --port', () => {
		const { error } = parseFlags(['--port', 'abc']);
		expect(error).toContain(USAGE);
	});
	test('negative --port', () => {
		const { error } = parseFlags(['--port=-5']);
		expect(error).toContain(USAGE);
	});
	test('out-of-range --port (> 65535)', () => {
		const { error } = parseFlags(['--port', '70000']);
		expect(error).toContain(USAGE);
	});
	test('negative --max-room-size', () => {
		const { error } = parseFlags(['--max-room-size=-1']);
		expect(error).toContain(USAGE);
	});
	test('--room-ttl 0 is valid (disables pruning)', () => {
		const r = parseFlags(['--room-ttl', '0']);
		expect(r.error).toBeUndefined();
		expect(r.config.roomTtl).toBe(0);
	});
	test('--max-room-size 0 is valid (unlimited)', () => {
		const r = parseFlags(['--max-room-size', '0']);
		expect(r.error).toBeUndefined();
		expect(r.config.maxRoomSize).toBe(0);
	});
});

describe('precedence: flag config beats env (in-process)', () => {
	const savedPort = process.env.PORT;
	const savedTtl  = process.env.ROOM_TTL;
	let server: ReturnType<typeof startServer> | undefined;

	afterAll(() => {
		server?.stop(true);
		if (savedPort === undefined) delete process.env.PORT; else process.env.PORT = savedPort;
		if (savedTtl === undefined) delete process.env.ROOM_TTL; else process.env.ROOM_TTL = savedTtl;
	});

	test('config.port wins over process.env.PORT', () => {
		process.env.PORT = '12321';
		server = startServer({ port: 0 });
		// port 0 asks the OS for an ephemeral port; it must not be the env value
		expect(server.port).not.toBe(12321);
		expect(typeof server.port).toBe('number');
	});

	// Smoke test only: nothing observable exposes the resolved ttl without waiting
	// on Bun.cron, and a nonsense ROOM_TTL also starts fine (the isNaN guard
	// disables pruning), so this does NOT prove roomTtl won. The parser unit tests
	// plus the `?? ` resolution line in startServer carry that weight.
	test('server starts with roomTtl in config and a nonsense ROOM_TTL env', async () => {
		process.env.ROOM_TTL = 'garbage';
		const s = startServer({ port: 0, roomTtl: 1 });
		expect(await waitForHealth(s.port as number)).toBe(true);
		s.stop(true);
	});
});

describe('subprocess smoke tests', () => {
	const procs: ReturnType<typeof Bun.spawn>[] = [];

	function spawnServer(args: string[], env?: Record<string, string>): ReturnType<typeof Bun.spawn> {
		const proc = spawnEntry(args, env);
		procs.push(proc);
		return proc;
	}

	afterAll(() => {
		for (const p of procs) p.kill();
	});

	test('--port serves /health_check on that port', async () => {
		const port = pickPort();
		spawnServer(['--port', String(port)]);
		expect(await waitForHealth(port)).toBe(true);
	});

	test('--port beats a conflicting PORT env on the spawned process', async () => {
		const flagPort = pickPort();
		const envPort  = pickPort();
		spawnServer(['--port', String(flagPort)], { PORT: String(envPort) });
		expect(await waitForHealth(flagPort)).toBe(true);
	});

	test('--help exits 0 with usage on stdout', async () => {
		const proc = spawnServer(['--help']);
		const code = await proc.exited;
		const out  = await new Response(proc.stdout as ReadableStream).text();
		expect(code).toBe(0);
		expect(out).toContain('Usage:');
		expect(out).toContain('flag > environment variable > default');
	});

	test('--version exits 0 with the version line on stdout', async () => {
		const proc = spawnServer(['--version']);
		const code = await proc.exited;
		const out  = await new Response(proc.stdout as ReadableStream).text();
		expect(code).toBe(0);
		expect(out).toMatch(/^COVCOM v\d+\.\d+\.\d+ \(protocol 0x[0-9a-f]{2}\)$/m);
	});

	test('--port abc exits 1 with usage on stderr', async () => {
		const proc = spawnServer(['--port', 'abc']);
		const code = await proc.exited;
		const err  = await new Response(proc.stderr as ReadableStream).text();
		expect(code).toBe(1);
		expect(err).toContain('Usage:');
	});
});
