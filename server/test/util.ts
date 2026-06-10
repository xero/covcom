import { join } from 'node:path';
import { startServer } from '../src/index.ts';
import type { ServerConfig } from '../src/index.ts';

// Shared dual-mode test plumbing. COVCOM_SERVER_BIN selects the target: unset,
// the suites run startServer() in-process and cover the programmatic config
// API; set to a compiled binary path (absolute, or relative to server/), they
// spawn the binary with config passed as flags, covering the production config
// path. The assertions never change between modes; a test that would need to
// differ has found a server bug, not a harness gap.

const SERVER_DIR = join(import.meta.dir, '..');
export const SERVER_BIN = process.env.COVCOM_SERVER_BIN;

export function pickPort(): number {
	return 40000 + Math.floor(Math.random() * 5000);
}

export async function waitForHealth(port: number, timeoutMs = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/health_check`);
			if (res.status === 200) return true;
		} catch { /* not up yet */ }
		await Bun.sleep(50);
	}
	return false;
}

// Spawn the server entry point as a subprocess: the compiled binary when
// COVCOM_SERVER_BIN is set, else `bun run src/index.ts`. Either way the flag
// parser and the import.meta.main block run for real.
export function spawnServer(args: string[], env?: Record<string, string>): ReturnType<typeof Bun.spawn> {
	const cmd = SERVER_BIN === undefined ? ['bun', 'run', 'src/index.ts', ...args] : [SERVER_BIN, ...args];
	return Bun.spawn(cmd, {
		cwd: SERVER_DIR,
		env: { ...process.env, ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
}

export interface TestServer {
	port: number
	stop(): Promise<unknown>
}

function configFlags(config: ServerConfig): string[] {
	const flags = ['--port', String(config.port ?? 0)];
	if (config.maxRoomSize !== undefined) flags.push('--max-room-size', String(config.maxRoomSize));
	if (config.adminToken !== undefined) flags.push('--admin-token', config.adminToken);
	if (config.hostname !== undefined) flags.push('--host', config.hostname);
	if (config.roomTtl !== undefined) flags.push('--room-ttl', String(config.roomTtl));
	return flags;
}

// --port 0 asks the OS for an ephemeral port, so the listening line on stdout
// is the only place the real port exists in binary mode.
async function readListeningPort(proc: ReturnType<typeof Bun.spawn>): Promise<number> {
	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
	const dec = new TextDecoder();
	let buf = '';
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		const m = buf.match(/listening on [^:]+:(\d+)/);
		if (m) {
			reader.releaseLock();
			return Number(m[1]);
		}
	}
	throw new Error(`server exited without reporting a listening port: ${buf}`);
}

export async function startTestServer(config: ServerConfig = {}): Promise<TestServer> {
	if (SERVER_BIN === undefined) {
		const srv = startServer({ port: 0, ...config });
		// stop(true) can hang on sockets the server closed mid-handshake
		// (version_mismatch, zombie close), so every stop races a short timeout.
		return {
			port: srv.port as number,
			stop: () => Promise.race([srv.stop(true), Bun.sleep(500)]),
		};
	}
	const proc = spawnServer(configFlags(config));
	const port = await readListeningPort(proc);
	if (!(await waitForHealth(port))) {
		proc.kill();
		throw new Error('spawned server never answered /health_check');
	}
	return {
		port,
		stop: async () => {
			proc.kill();
			await proc.exited;
		},
	};
}
