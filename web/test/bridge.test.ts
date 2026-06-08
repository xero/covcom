import { beforeEach, describe, expect, test } from 'bun:test';
import type { FingerprintSurface } from '@covcom/lib';
import { wireBridge } from '../src/bridge.ts';
import { Emitter } from '../src/emitter.ts';
import { dispatch, getState } from '../src/store.ts';
import type { CovcomSession } from '../src/session.ts';
import type { SessionEvents } from '../src/session.ts';
import type { Room } from '../src/store.ts';

// Drive the bridge with a fake session: a bare Emitter with a public `fire`.
// `import type` on SessionEvents/CovcomSession keeps session.ts (and its crypto
// imports) out of the runtime graph; the bridge only ever calls `session.on`.
class FakeSession extends Emitter<SessionEvents> {
	fire<K extends keyof SessionEvents>(k: K, p: SessionEvents[K]): void {
		this.emit(k, p);
	}
}

function fp(hex: string): FingerprintSurface {
	return { hex, swatches: ['#111111'], badge: '#222222' } as unknown as FingerprintSurface;
}

const room = (): Room => ({ id: 'r'.repeat(32), secret: new Uint8Array(16), dns: 'localhost:1337' });

const last = <T>(a: readonly T[]): T => a[a.length - 1];

let session: FakeSession;
let unwire: () => void;

beforeEach(() => {
	dispatch({ type: 'RESET' });
	session = new FakeSession();
	unwire = wireBridge(session as unknown as CovcomSession);
});

describe('phase → screen', () => {
	test('joining / waiting / ready map to the matching screen', () => {
		session.fire('phase', { phase: 'joining', room: room(), username: 'a' });
		expect(getState().screen.name).toBe('joining');
		session.fire('phase', { phase: 'waiting', room: room(), username: 'a' });
		expect(getState().screen.name).toBe('waiting');
		session.fire('phase', { phase: 'ready', room: room(), username: 'a' });
		expect(getState().screen.name).toBe('ready');
	});
});

describe('peers', () => {
	test('peer-joined adds peer, a system line, and an event-log entry', () => {
		session.fire('peer-joined', { username: 'bob', fingerprint: fp('bb') });
		const s = getState();
		expect(s.peers.has('bob')).toBe(true);
		expect(last(s.messages)).toMatchObject({ kind: 'system', text: [{ b: 'bob' }, ' joined'] });
		expect(last(s.events)).toMatchObject({ kind: 'join', direction: 'local', details: { username: 'bob', fpHex: 'bb' } });
	});

	test('peer-known with an unchanged fingerprint → plain reconnect line', () => {
		session.fire('peer-joined', { username: 'bob', fingerprint: fp('bb') });
		session.fire('peer-known', { username: 'bob', fingerprint: fp('bb') });
		expect(last(getState().messages)).toMatchObject({ kind: 'system', className: 'rejoin', text: [{ b: 'bob' }, ' reconnected'] });
	});

	test('peer-known with a changed fingerprint → fp-changed warning', () => {
		session.fire('peer-joined', { username: 'bob', fingerprint: fp('bb') });
		session.fire('peer-known', { username: 'bob', fingerprint: fp('cc') });
		expect(last(getState().messages)).toMatchObject({ kind: 'system', className: 'rejoin fp-changed' });
		expect(last(getState().events).details).toMatchObject({ fpChanged: true });
	});

	test('peer-left removes the peer and logs it', () => {
		session.fire('peer-joined', { username: 'bob', fingerprint: fp('bb') });
		session.fire('peer-left', { username: 'bob' });
		expect(getState().peers.has('bob')).toBe(false);
		expect(last(getState().events)).toMatchObject({ kind: 'part', details: { username: 'bob' } });
	});

	test('local-fingerprint-changed updates the store', () => {
		session.fire('local-fingerprint-changed', { fingerprint: fp('dead') });
		expect(getState().localFingerprint?.hex).toBe('dead');
	});
});

describe('content events', () => {
	test('message → chat item + out/in event-log entry', () => {
		session.fire('message', { from: 'me', text: 'hi there', isSelf: true, epoch: 1, counter: 2, ts: 5 });
		const s = getState();
		expect(last(s.messages)).toMatchObject({ kind: 'message', from: 'me', text: 'hi there', isSelf: true });
		expect(last(s.events)).toMatchObject({ direction: 'out', kind: 'message', details: { from: 'me', epoch: 1, counter: 2 } });
	});

	test('inbound message logs direction "in"', () => {
		session.fire('message', { from: 'bob', text: 'yo', isSelf: false, epoch: 0, counter: 1, ts: 5 });
		expect(last(getState().events).direction).toBe('in');
	});

	test('file → file chat item + event-log entry', () => {
		session.fire('file', { from: 'bob', filename: 'a.bin', mime: 'application/octet-stream', size: 9, blob: new Blob([new Uint8Array(9)]), isSelf: false, ts: 7 });
		expect(last(getState().messages)).toMatchObject({ kind: 'file', filename: 'a.bin', size: 9 });
		expect(last(getState().events)).toMatchObject({ kind: 'file', direction: 'in' });
	});

	test('ratchet → ratchet chat item + event-log entry', () => {
		session.fire('ratchet', { from: 'me', isSelf: true, ts: 1 });
		expect(last(getState().messages)).toMatchObject({ kind: 'ratchet', from: 'me', isSelf: true });
		expect(last(getState().events)).toMatchObject({ kind: 'ratchet', direction: 'out' });
	});
});

describe('diagnostics events', () => {
	test('wire entry passes direction/kind/summary/details through', () => {
		session.fire('wire', { direction: 'out', kind: 'broadcast', summary: 'x', details: { a: 1 } });
		expect(last(getState().events)).toMatchObject({ direction: 'out', kind: 'broadcast', summary: 'x', details: { a: 1 } });
	});

	test('log entry is always direction "local"', () => {
		session.fire('log', { kind: 'reconnect', summary: 'retrying', details: { delay: 1000 } });
		expect(last(getState().events)).toMatchObject({ direction: 'local', kind: 'reconnect' });
	});

	test('info adds a system message and a log entry', () => {
		session.fire('info', { kind: 'send-fail', text: 'Send failed' });
		expect(last(getState().messages)).toMatchObject({ kind: 'system', text: 'Send failed' });
		expect(last(getState().events)).toMatchObject({ kind: 'send-fail', direction: 'local' });
	});
});

describe('fatal', () => {
	test('maps a known reason to a friendly message, resets, returns to landing', () => {
		session.fire('peer-joined', { username: 'bob', fingerprint: fp('bb') });
		session.fire('fatal', { reason: 'room_full', prefill: { username: 'me' } });
		const s = getState();
		expect(s.screen).toMatchObject({ name: 'landing', error: 'Room is full.', prefill: { username: 'me' } });
		// RESET cleared peers/messages that predated the fatal
		expect(s.peers.size).toBe(0);
		expect(s.messages).toHaveLength(0);
	});

	test('unknown reason falls back to a generic message', () => {
		session.fire('fatal', { reason: 'weird_thing' });
		expect((getState().screen as { error?: string }).error).toBe('Connection failed.');
	});
});

describe('connection lifecycle', () => {
	test('connection-lost and -restored append system + log entries', () => {
		session.fire('connection-lost', { at: 1 });
		expect(last(getState().messages)).toMatchObject({ kind: 'system', className: 'reconnect' });
		session.fire('connection-restored', { at: 2, downMs: 1234 });
		expect(last(getState().messages)).toMatchObject({ kind: 'system', text: 'connection restored' });
		expect(last(getState().events).details).toMatchObject({ downMs: 1234 });
	});
});

describe('unwire', () => {
	test('returned cleanup detaches every handler', () => {
		unwire();
		const before = getState().messages.length;
		session.fire('peer-joined', { username: 'ghost', fingerprint: fp('00') });
		expect(getState().messages.length).toBe(before);
		expect(getState().peers.has('ghost')).toBe(false);
	});
});
