import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { INVITE_VERSION, Session } from '@covcom/lib';
import { initCrypto } from '../src/init.ts';
import { b64enc } from '../src/util.ts';
import { installFakeWebSocket, makePeer } from './helpers.ts';
import type { OutboundMsg } from '../src/ws.ts';

// serializeInvite requires a 32-byte roomId and a roomSecret that decodes to
// 16 bytes (lib/src/invite.ts); doConnect builds an armored invite for the
// waiting screen, so the values must be valid or doConnect aborts mid-flow.
const ROOM   = 'roomroomroomroomroomroomroom1234'; // 32 bytes
const SECRET = b64enc(new Uint8Array(16));         // decodes to 16 bytes

// Replace the TUI façades with spies so the state machine's render calls are
// captured (and their option callbacks are reachable) without a real terminal.
const renderLanding = mock((_s: unknown, _o: unknown) => { /* noop */ });
const renderWaiting = mock((_s: unknown, _o: unknown) => { /* noop */ });
const renderJoin    = mock((_s: unknown, _o: unknown) => { /* noop */ });
const renderChat    = mock((_s: unknown, _o: unknown) => { /* noop */ });
const appendMessage = mock((_o: unknown) => { /* noop */ });
const appendFile    = mock((_o: unknown) => { /* noop */ });
const showModal     = mock((_o: unknown) => { /* noop */ });

mock.module('../src/tui/landing.ts', () => ({ renderLanding }));
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

const screen = {} as Parameters<Mount>[0];
let ws: ReturnType<typeof installFakeWebSocket>;

beforeEach(() => {
	for (const m of [renderLanding, renderWaiting, renderJoin, renderChat, appendMessage, appendFile, showModal]) m.mockClear();
	ws = installFakeWebSocket();
});
afterEach(() => ws.restore());

// last options object passed to a render spy
const opts = (m: typeof renderLanding) => m.mock.calls[m.mock.calls.length - 1][1] as Record<string, (...a: never[]) => unknown>;
const types = (sent: OutboundMsg[]) => sent.map(s => s.type);
const find = <T extends OutboundMsg['type']>(sent: OutboundMsg[], t: T) =>
	sent.find(s => s.type === t) as Extract<OutboundMsg, { type: T }> | undefined;

describe('create flow', () => {
	test('emits create → join → identify and enters waiting', () => {
		mount(screen, {});
		expect(renderLanding).toHaveBeenCalled();
		(opts(renderLanding).onCreate as (s: string, u: string) => void)('localhost:3000', 'alice');

		const sock = ws.last();
		sock.open();                                                     // ws.onOpen → create
		sock.emit({ type: 'room_created', roomId: ROOM, roomSecret: SECRET });
		sock.emit({ type: 'joined', members: [] });

		expect(types(sock.sent)).toEqual(['create', 'join', 'identify']);
		expect(find(sock.sent, 'identify')?.username).toBe('alice');
		expect(renderWaiting).toHaveBeenCalled();
	});
});

describe('join flow', () => {
	test('emits join → identify from the join view callback', () => {
		mount(screen, { username: 'bob' }, '/tmp/covcom-room2.room');
		expect(renderJoin).toHaveBeenCalled();
		(opts(renderJoin).onConnect as (inv: unknown) => void)({
			version: INVITE_VERSION, roomId: ROOM, roomSecret: SECRET, dns: 'localhost:3000',
		});

		const sock = ws.last();
		sock.open();
		sock.emit({ type: 'joined', members: [] });

		expect(types(sock.sent)).toEqual(['join', 'identify']);
	});
});

describe('handshake → ready', () => {
	test('reaches ready, fires the welcome ratchet once, sends and tears down', () => {
		mount(screen, {});
		(opts(renderLanding).onCreate as (s: string, u: string) => void)('localhost:3000', 'alice');
		const sock = ws.last();
		sock.open();
		sock.emit({ type: 'room_created', roomId: ROOM, roomSecret: SECRET });
		sock.emit({ type: 'joined', members: [] });

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
