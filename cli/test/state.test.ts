import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FILE_CHUNK_SIZE, initCrypto, INVITE_VERSION, PROTOCOL_VERSION, Session, WINDOW, encodeFileAck } from '@covcom/lib';
import { b64enc } from '../src/util.ts';
import { installFakeWebSocket, makePeer } from './helpers.ts';
import type { OutboundMsg } from '../src/ws.ts';

type Broadcast = Extract<OutboundMsg, { type: 'broadcast' }>;

// serializeInvite requires a 32-byte roomId and a roomSecret that decodes to
// 16 bytes (lib/src/invite.ts); doConnect builds an armored invite for the
// waiting screen, so the values must be valid or doConnect aborts mid-flow.
const ROOM   = 'roomroomroomroomroomroomroom1234'; // 32 bytes
const SECRET = b64enc(new Uint8Array(16));         // decodes to 16 bytes

// Replace the TUI façades with spies so the state machine's render calls are
// captured (and their option callbacks are reachable) without a real terminal.
const renderLanding = mock((_s: unknown, _o: unknown) => { /* noop */ });
const renderCreate  = mock((_s: unknown, _o: unknown) => { /* noop */ });
const renderWaiting = mock((_s: unknown, _o: unknown) => { /* noop */ });
const renderJoin    = mock((_s: unknown, _o: unknown) => { /* noop */ });
const renderChat    = mock((_s: unknown, _o: unknown) => { /* noop */ });
const appendMessage = mock((_o: unknown) => { /* noop */ });
const appendFile    = mock((_o: unknown) => { /* noop */ });
const showModal     = mock((_o: unknown) => { /* noop */ });

mock.module('../src/tui/landing.ts', () => ({ renderLanding, renderCreate }));
mock.module('../src/tui/waiting.ts', () => ({ renderWaiting }));
mock.module('../src/tui/join.ts',    () => ({ renderJoin }));
mock.module('../src/tui/chat.ts',    () => ({ renderChat, appendMessage, appendFile, showModal }));

type Mount = typeof import('../src/state.ts').mount;
let mount: Mount;
let doCleanup: () => void;

beforeAll(async () => {
	await initCrypto();
	mount     = (await import('../src/state.ts')).mount;
	doCleanup = (await import('../src/lifecycle.ts')).doCleanup;
});

// doCleanup() calls _screen.destroy() to restore the terminal; the render
// façades are mocked, so a destroy stub is the only Screen method exercised here.
const screen = { destroy() { /* noop */ } } as Parameters<Mount>[0];
let ws: ReturnType<typeof installFakeWebSocket>;

beforeEach(() => {
	for (const m of [renderLanding, renderCreate, renderWaiting, renderJoin, renderChat, appendMessage, appendFile, showModal]) m.mockClear();
	ws = installFakeWebSocket();
});
afterEach(() => ws.restore());

// last options object passed to a render spy
const opts = (m: typeof renderLanding) => m.mock.calls[m.mock.calls.length - 1][1] as Record<string, (...a: never[]) => unknown>;
const types = (sent: OutboundMsg[]) => sent.map(s => s.type);
const find = <T extends OutboundMsg['type']>(sent: OutboundMsg[], t: T) =>
	sent.find(s => s.type === t) as Extract<OutboundMsg, { type: T }> | undefined;
// system messages appended (auth-phase errors route here via _errorDisplay)
const systemMsgs = () =>
	appendMessage.mock.calls.map(c => c[0] as { sender: string; text: string }).filter(m => m.sender === 'system');

// Landing → Create screen → submit. Mirrors the user clicking Create Room on the
// landing, then Create Room again on the create sub-screen.
function doCreateFlow(server = 'localhost:1337', username = 'alice'): void {
	(opts(renderLanding).onCreateClick as (u: string) => void)(username);
	(opts(renderCreate).onCreate as (s: string, u: string) => void)(server, username);
}

describe('create flow', () => {
	test('emits create → join → identify and enters waiting', () => {
		mount(screen, {});
		expect(renderLanding).toHaveBeenCalled();
		doCreateFlow();

		const sock = ws.last();
		sock.open();                                                     // ws.onOpen → create
		sock.emit({ type: 'room_created', roomId: ROOM, roomSecret: SECRET, serverVersion: PROTOCOL_VERSION });
		sock.emit({ type: 'joined', members: [], serverVersion: PROTOCOL_VERSION });

		expect(types(sock.sent)).toEqual(['create', 'join', 'identify']);
		expect(find(sock.sent, 'identify')?.username).toBe('alice');
		expect(renderWaiting).toHaveBeenCalled();
	});
});

describe('join flow', () => {
	test('emits join → identify from the join view callback', () => {
		mount(screen, { username: 'bob' }, '/tmp/covcom-room2.room');
		expect(renderJoin).toHaveBeenCalled();
		(opts(renderJoin).onConnect as (inv: unknown, u: string) => void)({
			version: INVITE_VERSION, roomId: ROOM, roomSecret: SECRET, dns: 'localhost:1337',
		}, 'bob');

		const sock = ws.last();
		sock.open();
		sock.emit({ type: 'joined', members: [], serverVersion: PROTOCOL_VERSION });

		expect(types(sock.sent)).toEqual(['join', 'identify']);
		expect(find(sock.sent, 'identify')?.username).toBe('bob');
	});
});

describe('version mismatch', () => {
	test('older server (no serverVersion) surfaces the error inline, no identify', () => {
		mount(screen, {});
		doCreateFlow();
		const sock = ws.last();
		sock.open();
		sock.emit({ type: 'room_created', roomId: ROOM, roomSecret: SECRET }); // serverVersion omitted

		expect(types(sock.sent)).toEqual(['create']);          // bailed before join/identify
		expect(find(sock.sent, 'identify')).toBeUndefined();
		expect(renderWaiting).not.toHaveBeenCalled();
		// stays on the create screen (never re-rendered to landing); message inline
		expect(systemMsgs().some(m => m.text.startsWith('This server is running a different version.'))).toBe(true);
	});

	test('server version_mismatch error surfaces the error inline', () => {
		mount(screen, {});
		doCreateFlow();
		const sock = ws.last();
		sock.open();
		sock.emit({ type: 'error', reason: 'version_mismatch', serverVersion: PROTOCOL_VERSION });

		expect(renderWaiting).not.toHaveBeenCalled();
		expect(systemMsgs().some(m => m.text.startsWith('This server is running a different version.'))).toBe(true);
	});
});

describe('username taken', () => {
	test('tears down the ghost connection and surfaces the error on the join screen', () => {
		mount(screen, { username: 'bob' }, '/tmp/covcom-room2.room');
		(opts(renderJoin).onConnect as (inv: unknown, u: string) => void)({
			version: INVITE_VERSION, roomId: ROOM, roomSecret: SECRET, dns: 'localhost:1337',
		}, 'bob');
		const sock = ws.last();
		sock.open();
		sock.emit({ type: 'joined', members: [], serverVersion: PROTOCOL_VERSION }); // → doConnect, sends identify
		sock.emit({ type: 'error', reason: 'username_taken' });

		expect(sock.closed).toBe(true);                                    // ghost connection torn down
		// the join screen stays mounted (no bounce to landing); message inline
		expect(renderLanding).not.toHaveBeenCalled();
		expect(systemMsgs().map(m => m.text)).toContain('That username is taken in this room.');
	});
});

describe('handshake → ready', () => {
	test('reaches ready, fires the welcome ratchet once, sends and tears down', () => {
		mount(screen, {});
		doCreateFlow();
		const sock = ws.last();
		sock.open();
		sock.emit({ type: 'room_created', roomId: ROOM, roomSecret: SECRET, serverVersion: PROTOCOL_VERSION });
		sock.emit({ type: 'joined', members: [], serverVersion: PROTOCOL_VERSION });

		const aliceEk = find(sock.sent, 'identify')!.ek;

		const bob = makePeer(ROOM, 'bob');
		sock.emit(bob.peerJoined());                  // alice accepts claim, wraps+relays seed, expects 1 chain
		sock.emit(bob.relaySeed(aliceEk, 'alice'));   // alice unwraps bob's seed → ready

		expect(renderChat).toHaveBeenCalled();                                   // entered ready
		expect(types(sock.sent)).toContain('relay');                             // seed sent to bob
		expect(sock.sent.filter(s => s.type === 'ratchet_step').length).toBe(1); // welcome ratchet fires exactly once

		// send a chat message through the ready view's onSend (= doSendMessage)
		const before = sock.sent.length;
		(opts(renderChat).onSend as (t: string) => void)('hello world');
		const bc = find(sock.sent.slice(before), 'broadcast');
		expect(bc).toBeDefined();
		expect(bc!.sig.length).toBeGreaterThan(0);
		expect(bc!.payload.length).toBeGreaterThan(0);
		expect(appendMessage).toHaveBeenCalled();                                // echoed locally

		// teardown disposes the live session and closes the socket
		const dispose = spyOn(Session.prototype, 'dispose');
		doCleanup();
		expect(dispose).toHaveBeenCalled();
		expect(sock.closed).toBe(true);
		dispose.mockRestore();

		bob.dispose();
	});
});

describe('streamed file send', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'covcom-cli-send-'));
	afterAll(() => rmSync(tmp, { recursive: true, force: true }));

	// Reach ready (mirrors the handshake test), then drive the chat view's onFile.
	function toReady(): ReturnType<ReturnType<typeof installFakeWebSocket>['last']> {
		mount(screen, {});
		doCreateFlow();
		const sock = ws.last();
		sock.open();
		sock.emit({ type: 'room_created', roomId: ROOM, roomSecret: SECRET, serverVersion: PROTOCOL_VERSION });
		sock.emit({ type: 'joined', members: [], serverVersion: PROTOCOL_VERSION });
		const aliceEk = find(sock.sent, 'identify')!.ek;
		const bob = makePeer(ROOM, 'bob');
		sock.emit(bob.peerJoined());
		sock.emit(bob.relaySeed(aliceEk, 'alice'));
		bob.dispose();
		return sock;
	}

	test('emits one file-begin then ordered file-chunk frames, last final, and echoes locally', async () => {
		const sock = toReady();
		expect(renderChat).toHaveBeenCalled();

		// > 2 chunks: two full chunks plus a remainder.
		const path = join(tmp, 'doc.bin');
		writeFileSync(path, Buffer.alloc(FILE_CHUNK_SIZE * 2 + 100, 7));

		const before = sock.sent.length;
		await (opts(renderChat).onFile as (p: string) => Promise<void>)(path);

		const frames = sock.sent.slice(before).filter(s => s.type === 'broadcast') as Broadcast[];
		const begins = frames.filter(f => (f.meta as { type?: string }).type === 'file-begin');
		const chunks = frames.filter(f => (f.meta as { type?: string }).type === 'file-chunk');

		expect(begins.length).toBe(1);
		expect(chunks.length).toBe(3);
		const meta = (f: Broadcast) => f.meta as { type: string; fileId: string; seq?: number; final?: boolean; size?: number; preamble?: string };

		expect(meta(begins[0]).size).toBe(FILE_CHUNK_SIZE * 2 + 100);
		expect(meta(begins[0]).preamble?.length).toBeGreaterThan(0);

		const fileId = meta(begins[0]).fileId;
		expect(chunks.map(c => meta(c).fileId)).toEqual([fileId, fileId, fileId]);
		expect(chunks.map(c => meta(c).seq)).toEqual([0, 1, 2]);
		expect(chunks.map(c => meta(c).final)).toEqual([false, false, true]);

		for (const f of frames) {
			expect(f.sig.length).toBeGreaterThan(0);
			expect(f.payload.length).toBeGreaterThan(0);
		}
		expect(appendFile).toHaveBeenCalledTimes(1);   // self echo, once

		doCleanup();
	});

	// Drive a transfer larger than the credit window with no acks: the sender must
	// stall after WINDOW chunks (so the dumb relay can't be overrun), then resume
	// when a tagged 0x01 relay ack advances the slowest-recipient seq.
	test('paces to the credit window and resumes on a 0x01 relay ack', async () => {
		const sock = toReady();   // bob is the lone recipient
		expect(renderChat).toHaveBeenCalled();

		const NCHUNKS = WINDOW + 6;
		const path = join(tmp, 'big.bin');
		writeFileSync(path, Buffer.alloc(FILE_CHUNK_SIZE * NCHUNKS, 7));   // exact multiple => NCHUNKS chunks

		const before = sock.sent.length;
		const chunkCount = () =>
			sock.sent.slice(before).filter(s => s.type === 'broadcast' && (s.meta as { type?: string }).type === 'file-chunk').length;

		// Fire without awaiting: with no acks the send loop blocks inside waitForCredit.
		const sendP = (opts(renderChat).onFile as (p: string) => Promise<void>)(path);

		// Let the initial window drain and the loop settle at its stall point.
		await settle(chunkCount);
		expect(chunkCount()).toBe(WINDOW);   // seq 0..WINDOW-1 sent, seq WINDOW blocked

		const begin = sock.sent.slice(before).find(
			s => s.type === 'broadcast' && (s.meta as { type?: string }).type === 'file-begin',
		) as Broadcast;
		const fileId = (begin.meta as { fileId: string }).fileId;

		// bob acks through seq WINDOW-1 → minAcked advances → window reopens.
		sock.emit({ type: 'relay', from: 'bob', payload: b64enc(encodeFileAck(fileId, WINDOW - 1)) });

		await sendP;   // the remainder now flows to completion
		expect(chunkCount()).toBe(NCHUNKS);
		expect(appendFile).toHaveBeenCalled();   // self echo only after the full send

		doCleanup();
	});
});

// Poll until `fn` returns the same value for several consecutive ticks, i.e. the
// async send loop has stopped making progress (stalled on backpressure).
async function settle(fn: () => number, ms = 25, rounds = 5): Promise<void> {
	let prev = NaN;
	let stable = 0;
	while (stable < rounds) {
		await new Promise(r => setTimeout(r, ms));
		const cur = fn();
		if (cur === prev) stable++;
		else {
			stable = 0; prev = cur;
		}
	}
}
