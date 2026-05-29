import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startServer } from '../src/index.ts';

// The HTTP surface of the broker (server.test.ts covers the WebSocket protocol).
// Only /health_check and /ws are real routes; everything else is 404.

let port:   number;
let server: ReturnType<typeof startServer>;

beforeAll(() => {
	server = startServer({ port: 0 });
	port   = server.port as number;
});

afterAll(() => server.stop(true));

describe('HTTP routes', () => {
	test('GET /health_check → 200 OK with permissive CORS', async () => {
		const res = await fetch(`http://localhost:${port}/health_check`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('OK');
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
	});

	test('unknown path → 404', async () => {
		const res = await fetch(`http://localhost:${port}/nope`);
		expect(res.status).toBe(404);
		expect(await res.text()).toBe('Not found');
	});

	test('GET /ws without upgrade headers → 500', async () => {
		// A plain GET cannot complete the WebSocket upgrade, so the handler reports
		// the failed upgrade rather than hanging.
		const res = await fetch(`http://localhost:${port}/ws`);
		expect(res.status).toBe(500);
		expect(await res.text()).toBe('Upgrade failed');
	});
});
