import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startServer } from '../src/index.ts';

type AnyMsg = Record<string, unknown>

// ML-KEM-768 ek/ratchetEk: base64 of 1184 bytes = exactly 1580 chars
const EK  = 'A'.repeat(1580);
const REK = 'B'.repeat(1580);
// Synthetic v3 identity-claim envelope and per-message signature.
// Server does not verify cryptographic content; only enforces shape + size.
const CLAIM = 'C'.repeat(300);
const SIG   = 'S'.repeat(88);

class TestWS {
	private ws: WebSocket;
	private queue: AnyMsg[] = [];
	private waiters: ((msg: AnyMsg) => void)[] = [];

	constructor(ws: WebSocket) {
		this.ws = ws;
		ws.onmessage = (e: MessageEvent) => {
			const msg = JSON.parse(e.data as string) as AnyMsg;
			const waiter = this.waiters.shift();
			if (waiter) waiter(msg);
			else this.queue.push(msg);
		};
	}

	send(msg: object): void {
		this.ws.send(JSON.stringify(msg));
	}

	sendRaw(data: string): void {
		this.ws.send(data);
	}

	recv(): Promise<AnyMsg> {
		const queued = this.queue.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		return new Promise(resolve => this.waiters.push(resolve));
	}

	tryRecv(ms = 100): Promise<AnyMsg | undefined> {
		const queued = this.queue.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		return new Promise(resolve => {
			let done = false;
			const fn = (msg: AnyMsg) => {
				if (!done) {
					done = true;
					resolve(msg);
				}
			};
			this.waiters.push(fn);
			setTimeout(() => {
				if (!done) {
					done = true;
					this.waiters = this.waiters.filter(w => w !== fn);
					resolve(undefined);
				}
			}, ms);
		});
	}

	close(): void {
		this.ws.close();
	}
}

async function connect(port: number): Promise<TestWS> {
	const ws = new WebSocket(`ws://localhost:${port}/ws`);
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error('WebSocket connection failed'));
	});
	return new TestWS(ws);
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function createAndJoin(port: number): Promise<{ ws: TestWS; roomId: string; roomSecret: string }> {
	const ws = await connect(port);
	ws.send({ type: 'create' });
	const created = await ws.recv();
	const { roomId, roomSecret } = created as { roomId: string; roomSecret: string };
	ws.send({ type: 'join', roomId, roomSecret });
	await ws.recv();  // joined
	return { ws, roomId, roomSecret };
}

// ── tests 1-21: default server config ────────────────────────────────────

describe('server: default config', () => {
	let port: number;
	let server: ReturnType<typeof startServer>;

	beforeAll(() => {
		server = startServer({ port: 0 });
		port = server.port as number;
	});

	afterAll(() => server.stop(true));

	test('1. room creation', async () => {
		const a = await connect(port);
		a.send({ type: 'create' });
		const msg = await a.recv();
		expect(msg.type).toBe('room_created');
		expect(typeof msg.roomId).toBe('string');
		expect((msg.roomId as string).length).toBeGreaterThan(0);
		expect(typeof msg.roomSecret).toBe('string');
		expect((msg.roomSecret as string).length).toBeGreaterThan(0);
		a.close();
	});

	test('2. room join', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		const msg = await b.recv();
		expect((msg as { type: string }).type).toBe('joined');

		a.close();
		b.close();
	});

	test('3. identity relay', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined

		a.send({ type: 'identify', username: 'alice', ek: EK, ratchetEk: REK, claim: CLAIM });
		const msg = await b.recv();
		expect(msg).toEqual({ type: 'peer_joined', username: 'alice', ek: EK, ratchetEk: REK, claim: CLAIM });

		a.close();
		b.close();
	});

	test('4. relay message', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined

		a.send({ type: 'identify', username: 'alice', ek: EK, ratchetEk: REK, claim: CLAIM });
		await b.recv(); // peer_joined alice

		b.send({ type: 'identify', username: 'bob', ek: EK, ratchetEk: REK, claim: CLAIM });
		await a.recv(); // peer_joined bob

		const payload = 'dGVzdC1wYXlsb2Fk';
		a.send({ type: 'relay', to: 'bob', payload });
		const msg = await b.recv();
		expect(msg).toEqual({ type: 'relay', from: 'alice', payload });

		a.close();
		b.close();
	});

	test('5. broadcast message', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined

		const c = await connect(port);
		c.send({ type: 'join', roomId, roomSecret });
		await c.recv(); // joined

		// identify all three; drain peer_joined notifications
		a.send({ type: 'identify', username: 'alice', ek: EK, ratchetEk: REK, claim: CLAIM });
		await b.recv(); // peer_joined alice
		await c.recv(); // peer_joined alice

		b.send({ type: 'identify', username: 'bob', ek: EK, ratchetEk: REK, claim: CLAIM });
		await a.recv(); // peer_joined bob
		await c.recv(); // peer_joined bob

		c.send({ type: 'identify', username: 'carol', ek: EK, ratchetEk: REK, claim: CLAIM });
		await a.recv(); // peer_joined carol
		await b.recv(); // peer_joined carol

		const payload = 'YnJvYWRjYXN0';
		const meta = { type: 'message', counter: 1, ts: 1713000000000 };
		b.send({ type: 'broadcast', payload, meta, sig: SIG });

		const [fromA, fromC] = await Promise.all([a.recv(), c.recv()]);
		expect(fromA).toEqual({ type: 'broadcast', from: 'bob', payload, meta, sig: SIG });
		expect(fromC).toEqual({ type: 'broadcast', from: 'bob', payload, meta, sig: SIG });

		// sender must not receive their own broadcast
		const fromB = await b.tryRecv(100);
		expect(fromB).toBeUndefined();

		a.close();
		b.close();
		c.close();
	});

	test('6. peer leave', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined

		a.send({ type: 'identify', username: 'alice', ek: EK, ratchetEk: REK, claim: CLAIM });
		await b.recv(); // peer_joined alice

		b.send({ type: 'identify', username: 'bob', ek: EK, ratchetEk: REK, claim: CLAIM });
		await a.recv(); // peer_joined bob

		a.close();
		const msg = await b.recv();
		expect(msg).toEqual({ type: 'peer_left', username: 'alice' });

		b.close();
	});

	test('7. rooms persist after all peers leave', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);
		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv();  // joined

		a.close();
		b.close();
		await delay(50);

		// room still exists; a new client can join
		const c = await connect(port);
		c.send({ type: 'join', roomId, roomSecret });
		const msg = await c.recv();
		expect(msg.type).toBe('joined');
		c.close();
	});

	test('9. roomSecret accepted on valid join', async () => {
		const a = await connect(port);
		a.send({ type: 'create' });
		const { roomId, roomSecret } = await a.recv() as { roomId: string; roomSecret: string };

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		const msg = await b.recv();
		expect((msg as { type: string }).type).toBe('joined');

		a.close();
		b.close();
	});

	test('10. wrong roomSecret rejected', async () => {
		const a = await connect(port);
		a.send({ type: 'create' });
		const { roomId } = await a.recv() as { roomId: string };

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret: 'wrong-secret' });
		const msg = await b.recv();
		expect(msg).toEqual({ type: 'error', reason: 'forbidden' });

		a.close();
		b.close();
	});

	test('11. username conflict', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined

		a.send({ type: 'identify', username: 'alice', ek: EK, ratchetEk: REK, claim: CLAIM });
		await b.recv(); // peer_joined alice

		b.send({ type: 'identify', username: 'alice', ek: EK, ratchetEk: REK, claim: CLAIM });
		const msg = await b.recv();
		expect(msg).toEqual({ type: 'error', reason: 'username_taken' });

		a.close();
		b.close();
	});

	test('12. malformed input', async () => {
		const a = await connect(port);

		// non-JSON is dropped silently, no response
		a.sendRaw('not json at all');
		const r1 = await a.tryRecv(100);
		expect(r1).toBeUndefined();

		// JSON with unknown type is dropped silently
		a.send({ type: 'frobnicate' } as object);
		const r2 = await a.tryRecv(100);
		expect(r2).toBeUndefined();

		// server is still responsive
		a.send({ type: 'create' });
		const msg = await a.recv();
		expect(msg.type).toBe('room_created');

		a.close();
	});

	test('13. ratchet_step fans out correctly', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined

		a.send({ type: 'identify', username: 'alice', ek: EK, ratchetEk: REK, claim: CLAIM });
		await b.recv(); // peer_joined alice

		b.send({ type: 'identify', username: 'bob', ek: EK, ratchetEk: REK, claim: CLAIM });
		await a.recv(); // peer_joined bob

		a.send({
			type: 'ratchet_step',
			payloads: { bob: { kemCt: 'x', encSeed: 'y', pn: 3 } },
			newEk: EK,
			payload: 'ciphertext',
			meta: { epoch: 1, counter: 0 },
			sig: SIG,
			claim: CLAIM,
		});

		const msg = await b.recv();
		expect(msg).toEqual({
			type: 'ratchet_step_fwd',
			from: 'alice',
			kemCt: 'x',
			encSeed: 'y',
			pn: 3,
			newEk: EK,
			payload: 'ciphertext',
			meta: { epoch: 1, counter: 0 },
			sig: SIG,
			claim: CLAIM,
		});

		// sender must not receive their own ratchet_step
		const fromA = await a.tryRecv(100);
		expect(fromA).toBeUndefined();

		a.close();
		b.close();
	});

	test('14. ratchet_step skips recipients not in payloads', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined

		const c = await connect(port);
		c.send({ type: 'join', roomId, roomSecret });
		await c.recv(); // joined

		a.send({ type: 'identify', username: 'alice', ek: EK, ratchetEk: REK, claim: CLAIM });
		await b.recv(); // peer_joined alice
		await c.recv(); // peer_joined alice

		b.send({ type: 'identify', username: 'bob', ek: EK, ratchetEk: REK, claim: CLAIM });
		await a.recv(); // peer_joined bob
		await c.recv(); // peer_joined bob

		c.send({ type: 'identify', username: 'carol', ek: EK, ratchetEk: REK, claim: CLAIM });
		await a.recv(); // peer_joined carol
		await b.recv(); // peer_joined carol

		// A sends ratchet_step with payload only for bob
		a.send({
			type: 'ratchet_step',
			payloads: { bob: { kemCt: 'x', encSeed: 'y', pn: 1 } },
			newEk: EK,
			payload: 'ct',
			meta: {},
			sig: SIG,
			claim: CLAIM,
		});

		await b.recv(); // ratchet_step_fwd to bob

		// carol should receive nothing
		const fromC = await c.tryRecv(100);
		expect(fromC).toBeUndefined();

		a.close();
		b.close();
		c.close();
	});

	test('16. ek_update broadcasts to all others', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined

		const c = await connect(port);
		c.send({ type: 'join', roomId, roomSecret });
		await c.recv(); // joined

		a.send({ type: 'identify', username: 'alice', ek: EK, ratchetEk: REK, claim: CLAIM });
		await b.recv();
		await c.recv();

		b.send({ type: 'identify', username: 'bob', ek: EK, ratchetEk: REK, claim: CLAIM });
		await a.recv();
		await c.recv();

		c.send({ type: 'identify', username: 'carol', ek: EK, ratchetEk: REK, claim: CLAIM });
		await a.recv();
		await b.recv();

		// A sends ek_update
		a.send({ type: 'ek_update', ek: 'new-rek-a', claim: CLAIM });

		const [fromB, fromC] = await Promise.all([b.recv(), c.recv()]);
		expect(fromB).toEqual({ type: 'ek_update_fwd', from: 'alice', ek: 'new-rek-a', claim: CLAIM });
		expect(fromC).toEqual({ type: 'ek_update_fwd', from: 'alice', ek: 'new-rek-a', claim: CLAIM });

		// sender must not receive their own ek_update
		const fromA = await a.tryRecv(100);
		expect(fromA).toBeUndefined();

		a.close();
		b.close();
		c.close();
	});

	test('17. peer_joined carries ratchetEk', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined

		b.send({ type: 'identify', username: 'bob', ek: EK, ratchetEk: REK, claim: CLAIM });
		const msg = await a.recv();
		expect(msg).toEqual({ type: 'peer_joined', username: 'bob', ek: EK, ratchetEk: REK, claim: CLAIM });

		a.close();
		b.close();
	});

	test('18. joined includes existing identified members', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined (members=[])

		// A and B identify
		a.send({ type: 'identify', username: 'alice', ek: EK, ratchetEk: REK, claim: CLAIM });
		await b.recv(); // peer_joined alice
		b.send({ type: 'identify', username: 'bob', ek: EK, ratchetEk: REK, claim: CLAIM });
		await a.recv(); // peer_joined bob

		// C joins and should receive alice and bob in members
		const c = await connect(port);
		c.send({ type: 'join', roomId, roomSecret });
		const joined = await c.recv();
		expect(joined.type).toBe('joined');
		const members = (joined as { members: unknown[] }).members;
		expect(members).toHaveLength(2);
		expect(members).toContainEqual({ username: 'alice', ek: EK, ratchetEk: REK, claim: CLAIM });
		expect(members).toContainEqual({ username: 'bob',   ek: EK, ratchetEk: REK, claim: CLAIM });

		a.close(); b.close(); c.close();
	});

	test('19. health_check returns 200', async () => {
		const res = await fetch(`http://localhost:${port}/health_check`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('OK');
	});

	test('20. creator not in room until join', async () => {
		const a = await connect(port);
		a.send({ type: 'create' });
		const { roomId, roomSecret } = await a.recv() as { roomId: string; roomSecret: string };

		// b joins and identifies before the creator joins
		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv();  // joined, no peer_joined because a is not in room yet
		b.send({ type: 'identify', username: 'bob', ek: EK, ratchetEk: REK, claim: CLAIM });

		// creator now joins, should see bob in members
		// if the bug existed (creator auto-added to room.conns), a would never
		// receive a 'joined' response at all, and this recv() would time out
		a.send({ type: 'join', roomId, roomSecret });
		const creatorJoined = await a.recv();
		const members = (creatorJoined as { members: { username: string }[] }).members;
		expect(members).toHaveLength(1);
		expect(members[0].username).toBe('bob');

		a.close();
		b.close();
	});

	test('21. rekey updates ConnData', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		a.send({ type: 'identify', username: 'alice', ek: EK, ratchetEk: REK, claim: CLAIM });
		// no other client yet to drain peer_joined

		// alice rekeyed (lobby transition; same connection, still identified)
		a.send({ type: 'rekey', ek: 'new-ek-a', ratchetEk: 'new-rek-a', claim: CLAIM });
		const rekeyed = await a.recv();
		expect(rekeyed).toEqual({ type: 'rekeyed' });

		// new joiner sees alice's NEW ek in joined.members
		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		const joined = await b.recv() as { type: string; members: { username: string; ek: string }[] };
		expect(joined.type).toBe('joined');
		const alice = joined.members.find(m => m.username === 'alice');
		expect(alice?.ek).toBe('new-ek-a');

		a.close();
		b.close();
	});

	test('22. joined.members reflects current ratchetEk after ek_update', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);
		a.send({ type: 'identify', username: 'alice', ek: EK, ratchetEk: REK, claim: CLAIM });

		// alice sends ek_update, simulates her receiving a ratchet_step_fwd and
		// rotating her keypair. the server must persist the new key so late joiners
		// see the current ratchetEk in joined.members, not the stale identify-time value.
		a.send({ type: 'ek_update', ek: 'updated-rek-a', claim: CLAIM });
		await delay(20);

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		const joined = await b.recv() as { members: { username: string; ratchetEk: string }[] };
		const alice = joined.members.find(m => m.username === 'alice');
		expect(alice?.ratchetEk).toBe('updated-rek-a');

		a.close();
		b.close();
	});
});

// ── test 8: room capacity ─────────────────────────────────────────────────

describe('server: room capacity', () => {
	let port: number;
	let server: ReturnType<typeof startServer>;

	beforeAll(() => {
		server = startServer({ port: 0, maxRoomSize: 2 });
		port = server.port as number;
	});

	afterAll(() => server.stop(true));

	test('8. room full', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		// second client joins, room now at capacity
		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		const joined = await b.recv();
		expect((joined as { type: string }).type).toBe('joined');

		// third client should be rejected
		const c = await connect(port);
		c.send({ type: 'join', roomId, roomSecret });
		const msg = await c.recv();
		expect(msg).toEqual({ type: 'error', reason: 'room_full' });

		a.close();
		b.close();
		c.close();
	});
});

// ── test 15: adminToken ───────────────────────────────────────────────────

describe('server: adminToken', () => {
	let port: number;
	let server: ReturnType<typeof startServer>;

	beforeAll(() => {
		server = startServer({ port: 0, adminToken: 'test-admin' });
		port = server.port as number;
	});

	afterAll(() => server.stop(true));

	test('15. adminToken gates room creation', async () => {
		// no adminToken field, rejected
		const a = await connect(port);
		a.send({ type: 'create' });
		const msg1 = await a.recv();
		expect(msg1).toEqual({ type: 'error', reason: 'forbidden' });
		a.close();

		// wrong adminToken, rejected
		const b = await connect(port);
		b.send({ type: 'create', adminToken: 'wrong' });
		const msg2 = await b.recv();
		expect(msg2).toEqual({ type: 'error', reason: 'forbidden' });
		b.close();

		// correct adminToken, accepted
		const c = await connect(port);
		c.send({ type: 'create', adminToken: 'test-admin' });
		const msg3 = await c.recv();
		expect(msg3.type).toBe('room_created');
		c.close();
	});
});

// ── unauthenticated message drop (Fix 4) ──────────────────────────────────

describe('unauthenticated message drop', () => {
	let port: number;
	let server: ReturnType<typeof startServer>;

	beforeAll(() => {
		server = startServer({ port: 0 });
		port = server.port as number;
	});

	afterAll(() => server.stop(true));

	test('broadcast dropped for unidentified sender', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);
		a.send({ type: 'identify', username: 'alice', ek: EK, ratchetEk: REK, claim: CLAIM });

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined, b never sends identify

		b.send({ type: 'broadcast', payload: 'ct', meta: {} });
		const msg = await a.tryRecv();
		expect(msg).toBeUndefined();

		a.close();
		b.close();
	});

	test('relay dropped for unidentified sender', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);
		a.send({ type: 'identify', username: 'alice', ek: EK, ratchetEk: REK, claim: CLAIM });

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined

		b.send({ type: 'relay', to: 'alice', payload: 'payload' });
		const msg = await a.tryRecv();
		expect(msg).toBeUndefined();

		a.close();
		b.close();
	});

	test('ratchet_step dropped for unidentified sender', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);
		a.send({ type: 'identify', username: 'alice', ek: EK, ratchetEk: REK, claim: CLAIM });

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined

		b.send({ type: 'ratchet_step', payloads: {}, newEk: 'x', payload: 'y', meta: {} });
		const msg = await a.tryRecv();
		expect(msg).toBeUndefined();

		a.close();
		b.close();
	});

	test('ek_update dropped for unidentified sender', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);
		a.send({ type: 'identify', username: 'alice', ek: EK, ratchetEk: REK, claim: CLAIM });

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined

		b.send({ type: 'ek_update', ek: 'newek' });
		const msg = await a.tryRecv();
		expect(msg).toBeUndefined();

		a.close();
		b.close();
	});
});

// ── join guard (Fix 5) ─────────────────────────────────────────────────────

describe('join guard', () => {
	let port: number;
	let server: ReturnType<typeof startServer>;

	beforeAll(() => {
		server = startServer({ port: 0 });
		port = server.port as number;
	});

	afterAll(() => server.stop(true));

	test('second join on same connection returns forbidden', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		a.send({ type: 'join', roomId, roomSecret });
		const msg = await a.recv();
		expect(msg).toEqual({ type: 'error', reason: 'forbidden' });

		a.close();
	});
});

// ── identify validation (Fix 6) ────────────────────────────────────────────

describe('identify validation', () => {
	let port: number;
	let server: ReturnType<typeof startServer>;

	beforeAll(() => {
		server = startServer({ port: 0 });
		port = server.port as number;
	});

	afterAll(() => {
		const stop = server.stop.bind(server);
		return Promise.race([
			stop(true),
			new Promise<void>(resolve => setTimeout(resolve, 500)),
		]);
	});

	test('empty username: no peer_joined delivered', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined

		b.send({ type: 'identify', username: '', ek: EK, ratchetEk: REK, claim: CLAIM });
		const msg = await a.tryRecv();
		expect(msg).toBeUndefined();

		a.close();
		b.close();
	});

	test('username over 64 chars: no peer_joined delivered', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined

		b.send({ type: 'identify', username: 'x'.repeat(65), ek: EK, ratchetEk: REK, claim: CLAIM });
		const msg = await a.tryRecv();
		expect(msg).toBeUndefined();

		a.close();
		b.close();
	});

	test('ek wrong length: no peer_joined delivered', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined

		b.send({ type: 'identify', username: 'bob', ek: 'short-ek', ratchetEk: REK, claim: CLAIM });
		const msg = await a.tryRecv();
		expect(msg).toBeUndefined();

		a.close();
		b.close();
	});

	test('ratchetEk wrong length: no peer_joined delivered', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined

		b.send({ type: 'identify', username: 'bob', ek: EK, ratchetEk: 'short-rek', claim: CLAIM });
		const msg = await a.tryRecv();
		expect(msg).toBeUndefined();

		a.close();
		b.close();
	});

	test('valid inputs at exact limits: peer_joined delivered', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined

		b.send({ type: 'identify', username: 'x'.repeat(64), ek: EK, ratchetEk: REK, claim: CLAIM });
		const msg = await a.recv();
		expect(msg).toEqual({ type: 'peer_joined', username: 'x'.repeat(64), ek: EK, ratchetEk: REK, claim: CLAIM });

		a.close();
		b.close();
	});

	test('control-char username (ESC/CSI) is rejected: no peer_joined delivered', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined

		// An escape-injection username must be dropped before broadcast, so the
		// peer never sees a peer_joined carrying control bytes.
		b.send({ type: 'identify', username: 'ev\x1b[2Jil', ek: EK, ratchetEk: REK, claim: CLAIM });
		expect(await a.tryRecv()).toBeUndefined();

		a.close();
		b.close();
	});

	test('BEL/NUL control chars in username are rejected', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined

		b.send({ type: 'identify', username: 'bell\x07null\x00', ek: EK, ratchetEk: REK, claim: CLAIM });
		expect(await a.tryRecv()).toBeUndefined();

		a.close();
		b.close();
	});

	test('benign unicode username is accepted', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined

		// The control-char rule must not reject ordinary printable Unicode.
		b.send({ type: 'identify', username: 'naïve🙂', ek: EK, ratchetEk: REK, claim: CLAIM });
		const msg = await a.recv();
		expect(msg).toEqual({ type: 'peer_joined', username: 'naïve🙂', ek: EK, ratchetEk: REK, claim: CLAIM });

		a.close();
		b.close();
	});

	test('bidi-override username (RLO) is rejected', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined

		// U+202E reverses the text that follows it — a classic display-name spoof.
		const rlo = String.fromCodePoint(0x202e);
		b.send({ type: 'identify', username: `ev${rlo}il`, ek: EK, ratchetEk: REK, claim: CLAIM });
		expect(await a.tryRecv()).toBeUndefined();

		a.close();
		b.close();
	});

	test('zero-width-space username is rejected', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined

		const zwsp = String.fromCodePoint(0x200b);
		b.send({ type: 'identify', username: `al${zwsp}ice`, ek: EK, ratchetEk: REK, claim: CLAIM });
		expect(await a.tryRecv()).toBeUndefined();

		a.close();
		b.close();
	});

	test('ZWJ in a username is accepted (legit emoji sequences, not over-rejected)', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		await b.recv(); // joined

		// ZWJ (U+200D) joins emoji sequences and is intentionally allowed.
		const uname = `fam${String.fromCodePoint(0x200d)}ily`;
		b.send({ type: 'identify', username: uname, ek: EK, ratchetEk: REK, claim: CLAIM });
		const msg = await a.recv();
		expect(msg).toEqual({ type: 'peer_joined', username: uname, ek: EK, ratchetEk: REK, claim: CLAIM });

		a.close();
		b.close();
	});
});

// ── identify cleanup (Fix 7) ──────────────────────────────────────────────

describe('identify cleanup', () => {
	let port: number;
	let server: ReturnType<typeof startServer>;

	beforeAll(() => {
		server = startServer({ port: 0, maxRoomSize: 1 });
		port = server.port as number;
	});

	afterAll(() => {
		const stop = server.stop.bind(server);
		return Promise.race([
			stop(true),
			new Promise<void>(resolve => setTimeout(resolve, 500)),
		]);
	});

	test('zombie close frees room slot', async () => {
		const { ws: a, roomId, roomSecret } = await createAndJoin(port);

		// first client joins but sends an oversized username, server closes it
		a.send({ type: 'identify', username: 'x'.repeat(65), ek: EK, ratchetEk: REK, claim: CLAIM });
		// wait for the server-initiated close to complete
		await delay(200);

		// second client should be able to join the same room (slot was freed)
		const b = await connect(port);
		b.send({ type: 'join', roomId, roomSecret });
		const msg = await b.recv();
		expect(msg.type).toBe('joined');

		a.close();
		b.close();
		await delay(50);
	});
});
