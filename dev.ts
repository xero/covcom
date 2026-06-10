#!/usr/bin/env bun
/**
 * dev.ts - run the relay and the web client together for interactive testing.
 *
 * Usage:
 *   bun dev              # relay on :1337, SPA on Vite's port
 *   PORT=8080 bun dev    # relay on :8080, SPA prefilled with localhost:8080
 *
 * Starts `dev:server` and `dev:web` as children. PORT (default 1337) drives the
 * relay; the same value is handed to Vite as VITE_DEFAULT_SERVER so the web client's
 * create screen prefills the matching server address instead of Vite's own port.
 * Ctrl+C (SIGINT/SIGTERM), or either child exiting, brings both down.
 */

const port  = process.env.PORT ?? '1337';
const relay = `127.0.0.1:${port}`;

const procs = [
	Bun.spawn(['bun', 'run', 'dev:server'], {
		env: { ...process.env, PORT: port },
		stdio: ['inherit', 'inherit', 'inherit'],
	}),
	Bun.spawn(['bun', 'run', 'dev:web'], {
		env: { ...process.env, VITE_DEFAULT_SERVER: relay },
		stdio: ['inherit', 'inherit', 'inherit'],
	}),
];

let down = false;
function shutdown(code = 0): never {
	if (!down) {
		down = true;
		for (const p of procs) p.kill();  // SIGTERM
	}
	process.exit(code);
}

process.on('SIGINT',  () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// If either process exits on its own, take the other down with it.
for (const p of procs) p.exited.then((code: number | null) => shutdown(code ?? 0));
