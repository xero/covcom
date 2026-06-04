// In-memory WebSocket + broker for unit-testing CovcomSession without a server
// or a browser. CovcomSession constructs `new WebSocket(...)` internally (the
// socket is not injectable), so we swap globalThis.WebSocket for MockWebSocket
// and route every frame through a Broker that mirrors server/src/relay.ts +
// server/src/index.ts message routing. Two real CovcomSession instances can
// then complete a full handshake and exchange real ciphertext in-process.
//
// Routing fidelity (which frame goes to whom) matches the server exactly; the
// server's byte-length validation is intentionally omitted; that is the
// server's concern and is covered by server/test/server.test.ts.

import { PROTOCOL_VERSION } from '@covcom/lib';

interface ConnData {
	roomId:    string | null;
	username:  string | null;
	ek:        string | null;
	ratchetEk: string | null;
	claim:     string | null;
}

type AnyMsg = Record<string, unknown> & { type: string };

interface RoomState {
	secret: string;
	conns:  Set<MockWebSocket>;
}

// Deterministic room ids/secrets; no Math.random (banned) and reproducible.
function roomId(n: number): string {
	return `room${n}`.padEnd(32, '0').slice(0, 32);
}
function roomSecretB64(n: number): string {
	const bytes = new Uint8Array(16).fill((n % 250) + 1);
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

class Broker {
	private rooms = new Map<string, RoomState>();
	private seq   = 0;
	// When set, room_created/joined omit serverVersion, mimicking a pre-v3
	// server that predates version negotiation (the friend's v2 case).
	simulateOldServer = false;

	reset(): void {
		this.rooms.clear();
		this.seq = 0;
		this.simulateOldServer = false;
	}

	handle(ws: MockWebSocket, msg: AnyMsg): void {
		switch (msg.type) {
		case 'create':   return this.create(ws);
		case 'join':     return this.join(ws, msg);
		case 'identify': return this.identify(ws, msg);
		case 'relay':    return this.relay(ws, msg);
		case 'broadcast':return this.broadcast(ws, msg);
		case 'ratchet_step': return this.ratchetStep(ws, msg);
		case 'ek_update':    return this.ekUpdate(ws, msg);
		case 'rekey':        return this.rekey(ws, msg);
		}
	}

	disconnect(ws: MockWebSocket): void {
		if (!ws.data.roomId) return;
		const room = this.rooms.get(ws.data.roomId);
		if (!room) return;
		room.conns.delete(ws);
		if (ws.data.username)
			for (const conn of room.conns) conn.deliver({ type: 'peer_left', username: ws.data.username });
	}

	private create(ws: MockWebSocket): void {
		const id     = roomId(this.seq);
		const secret = roomSecretB64(this.seq);
		this.seq++;
		this.rooms.set(id, { secret, conns: new Set() });
		ws.deliver(this.simulateOldServer
			? { type: 'room_created', roomId: id, roomSecret: secret }
			: { type: 'room_created', roomId: id, roomSecret: secret, serverVersion: PROTOCOL_VERSION });
	}

	private join(ws: MockWebSocket, msg: AnyMsg): void {
		if (ws.data.roomId) return ws.deliver({ type: 'error', reason: 'forbidden' });
		const room = this.rooms.get(msg.roomId as string);
		if (!room) return ws.deliver({ type: 'error', reason: 'not_found' });
		if (msg.roomSecret !== room.secret) return ws.deliver({ type: 'error', reason: 'forbidden' });
		room.conns.add(ws);
		ws.data.roomId = msg.roomId as string;
		const members: { username: string; ek: string; ratchetEk: string; claim: string }[] = [];
		for (const conn of room.conns)
			if (conn !== ws && conn.data.username && conn.data.ek && conn.data.ratchetEk && conn.data.claim)
				members.push({ username: conn.data.username, ek: conn.data.ek, ratchetEk: conn.data.ratchetEk, claim: conn.data.claim });
		ws.deliver(this.simulateOldServer
			? { type: 'joined', members }
			: { type: 'joined', members, serverVersion: PROTOCOL_VERSION });
	}

	private identify(ws: MockWebSocket, msg: AnyMsg): void {
		if (!ws.data.roomId) return;
		const room  = this.rooms.get(ws.data.roomId);
		if (!room) return;
		const uname = (msg.username as string).trim();
		for (const conn of room.conns)
			if (conn !== ws && conn.data.username === uname) return ws.deliver({ type: 'error', reason: 'username_taken' });
		ws.data.username  = uname;
		ws.data.ek        = msg.ek as string;
		ws.data.ratchetEk = msg.ratchetEk as string;
		ws.data.claim     = msg.claim as string;
		for (const conn of room.conns)
			if (conn !== ws)
				conn.deliver({ type: 'peer_joined', username: uname, ek: msg.ek, ratchetEk: msg.ratchetEk, claim: msg.claim });
	}

	private relay(ws: MockWebSocket, msg: AnyMsg): void {
		const room = this.roomOf(ws);
		if (!room) return;
		for (const conn of room.conns)
			if (conn.data.username === msg.to)
				return conn.deliver({ type: 'relay', from: ws.data.username, payload: msg.payload });
	}

	private broadcast(ws: MockWebSocket, msg: AnyMsg): void {
		const room = this.roomOf(ws);
		if (!room) return;
		for (const conn of room.conns)
			if (conn !== ws)
				conn.deliver({ type: 'broadcast', from: ws.data.username, payload: msg.payload, meta: msg.meta, sig: msg.sig });
	}

	private ratchetStep(ws: MockWebSocket, msg: AnyMsg): void {
		const room = this.roomOf(ws);
		if (!room) return;
		ws.data.ratchetEk = msg.newEk as string;
		ws.data.claim     = msg.claim as string;
		const payloads = msg.payloads as Record<string, { kemCt: string; encSeed: string; pn: number }>;
		for (const conn of room.conns) {
			if (conn === ws || !conn.data.username) continue;
			const peer = payloads[conn.data.username];
			if (!peer) continue;
			conn.deliver({
				type: 'ratchet_step_fwd', from: ws.data.username,
				kemCt: peer.kemCt, encSeed: peer.encSeed, pn: peer.pn,
				newEk: msg.newEk, payload: msg.payload, meta: msg.meta, sig: msg.sig, claim: msg.claim,
			});
		}
	}

	private ekUpdate(ws: MockWebSocket, msg: AnyMsg): void {
		const room = this.roomOf(ws);
		if (!room) return;
		ws.data.ratchetEk = msg.ek as string;
		ws.data.claim     = msg.claim as string;
		for (const conn of room.conns)
			if (conn !== ws)
				conn.deliver({ type: 'ek_update_fwd', from: ws.data.username, ek: msg.ek, claim: msg.claim });
	}

	private rekey(ws: MockWebSocket, msg: AnyMsg): void {
		const room = this.roomOf(ws);
		if (!room) return;
		ws.data.ek        = msg.ek as string;
		ws.data.ratchetEk = msg.ratchetEk as string;
		ws.data.claim     = msg.claim as string;
		ws.deliver({ type: 'rekeyed' });
	}

	private roomOf(ws: MockWebSocket): RoomState | undefined {
		if (!ws.data.roomId || !ws.data.username) return undefined;
		return this.rooms.get(ws.data.roomId);
	}
}

export const broker = new Broker();

export class MockWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN       = 1;
	static readonly CLOSING    = 2;
	static readonly CLOSED     = 3;

	readyState = MockWebSocket.CONNECTING;
	onopen:        (() => void) | null = null;
	onmessage:     ((e: { data: string }) => void) | null = null;
	onclose:       (() => void) | null = null;
	onerror:       (() => void) | null = null;

	data: ConnData = { roomId: null, username: null, ek: null, ratchetEk: null, claim: null };

	constructor(public url: string) {
		queueMicrotask(() => {
			if (this.readyState !== MockWebSocket.CONNECTING) return;
			this.readyState = MockWebSocket.OPEN;
			this.onopen?.();
		});
	}

	send(raw: string): void {
		if (this.readyState !== MockWebSocket.OPEN) return;
		broker.handle(this, JSON.parse(raw) as AnyMsg);
	}

	// Server → client. Scheduled (never synchronous) to mimic the network and to
	// avoid re-entrant recursion through the session's send handlers.
	deliver(msg: Record<string, unknown>): void {
		queueMicrotask(() => {
			if (this.readyState !== MockWebSocket.OPEN) return;
			this.onmessage?.({ data: JSON.stringify(msg) });
		});
	}

	close(): void {
		if (this.readyState === MockWebSocket.CLOSED) return;
		this.readyState = MockWebSocket.CLOSED;
		broker.disconnect(this);
		this.onclose?.();
	}
}

let saved: typeof globalThis.WebSocket | undefined;

export function installMockWebSocket(): void {
	saved = globalThis.WebSocket;
	broker.reset();
	(globalThis as { WebSocket: unknown }).WebSocket = MockWebSocket;
}

export function uninstallMockWebSocket(): void {
	if (saved) (globalThis as { WebSocket: unknown }).WebSocket = saved;
}

// Pump the event loop until `cond()` holds or the budget elapses. Deliveries run
// on the microtask queue; a macrotask yield lets queued chains drain.
export async function waitUntil(cond: () => boolean, ms = 3000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error('waitUntil: timed out');
		await new Promise(r => setTimeout(r, 5));
	}
}
