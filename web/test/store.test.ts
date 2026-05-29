import { beforeEach, describe, expect, test } from 'bun:test';
import type { FingerprintSurface } from '@covcom/lib';
import { dispatch, getState, subscribe, SIDEBAR_DEFAULTS } from '../src/store.ts';
import type { Room } from '../src/store.ts';

// Synthetic fingerprint surface — store only stores it, never derives it.
function fp(hex: string): FingerprintSurface {
	return { hex, swatches: ['#101010', '#202020'], badge: '#303030' } as unknown as FingerprintSurface;
}

const room = (id = 'r'.repeat(32)): Room => ({ id, secret: new Uint8Array(16), dns: 'localhost:3000' });

// The store is a module singleton; RESET returns it to the initial state and
// rewinds the event-id counter, so every test starts from a known baseline.
beforeEach(() => dispatch({ type: 'RESET' }));

describe('screen transitions', () => {
	test('starts on landing', () => {
		expect(getState().screen.name).toBe('landing');
	});

	test('GOTO_JOINING/WAITING/READY carry room + username', () => {
		const r = room();
		dispatch({ type: 'GOTO_JOINING', room: r, username: 'alice' });
		expect(getState().screen).toMatchObject({ name: 'joining', username: 'alice' });
		dispatch({ type: 'GOTO_WAITING', room: r, username: 'alice' });
		expect(getState().screen.name).toBe('waiting');
		dispatch({ type: 'GOTO_READY', room: r, username: 'alice' });
		expect(getState().screen).toMatchObject({ name: 'ready', room: r, username: 'alice' });
	});

	test('GOTO_LANDING carries error + prefill', () => {
		dispatch({ type: 'GOTO_LANDING', error: 'nope', prefill: { username: 'bob' } });
		expect(getState().screen).toEqual({ name: 'landing', error: 'nope', prefill: { username: 'bob' } });
	});
});

describe('peers', () => {
	test('PEER_ADDED assigns colorIdx starting at 1 (self owns 0)', () => {
		dispatch({ type: 'PEER_ADDED', username: 'a', fingerprint: fp('aa') });
		dispatch({ type: 'PEER_ADDED', username: 'b', fingerprint: fp('bb') });
		expect(getState().peers.get('a')?.colorIdx).toBe(1);
		expect(getState().peers.get('b')?.colorIdx).toBe(2);
	});

	test('re-adding a peer updates fingerprint, keeps colorIdx', () => {
		dispatch({ type: 'PEER_ADDED', username: 'a', fingerprint: fp('aa') });
		dispatch({ type: 'PEER_ADDED', username: 'a', fingerprint: fp('cc') });
		expect(getState().peers.size).toBe(1);
		expect(getState().peers.get('a')).toMatchObject({ colorIdx: 1 });
		expect(getState().peers.get('a')?.fingerprint.hex).toBe('cc');
	});

	test('PEER_REMOVED deletes the peer', () => {
		dispatch({ type: 'PEER_ADDED', username: 'a', fingerprint: fp('aa') });
		dispatch({ type: 'PEER_REMOVED', username: 'a' });
		expect(getState().peers.has('a')).toBe(false);
	});

	test('LOCAL_FINGERPRINT sets localFingerprint', () => {
		dispatch({ type: 'LOCAL_FINGERPRINT', fingerprint: fp('dead') });
		expect(getState().localFingerprint?.hex).toBe('dead');
	});
});

describe('chat items', () => {
	test('message/file/system/ratchet append in order', () => {
		dispatch({ type: 'MESSAGE_APPENDED', item: { kind: 'message', from: 'a', text: 'hi', isSelf: false, ts: 1 } });
		dispatch({ type: 'FILE_APPENDED', item: { kind: 'file', from: 'a', filename: 'f.txt', mime: 'text/plain', size: 3, bytes: new Uint8Array([1, 2, 3]), isSelf: false, ts: 2 } });
		dispatch({ type: 'SYSTEM_APPENDED', text: 'sys', className: 'rejoin' });
		dispatch({ type: 'RATCHET_APPENDED', from: 'a', isSelf: true });
		const kinds = getState().messages.map(m => m.kind);
		expect(kinds).toEqual(['message', 'file', 'system', 'ratchet']);
		const sys = getState().messages[2];
		expect(sys).toMatchObject({ kind: 'system', text: 'sys', className: 'rejoin' });
	});
});

describe('event log', () => {
	test('EVENT_LOGGED assigns incrementing ids + a timestamp', () => {
		dispatch({ type: 'EVENT_LOGGED', entry: { direction: 'out', kind: 'message', summary: 's', details: {} } });
		dispatch({ type: 'EVENT_LOGGED', entry: { direction: 'in', kind: 'message', summary: 's', details: {}, ts: 42 } });
		const [a, b] = getState().events;
		expect(a.id).toBe(1);
		expect(b.id).toBe(2);
		expect(b.ts).toBe(42);
		expect(typeof a.ts).toBe('number');
	});

	test('caps at 500 entries, evicting oldest first', () => {
		for (let i = 0; i < 520; i++)
			dispatch({ type: 'EVENT_LOGGED', entry: { direction: 'local', kind: 'k', summary: String(i), details: {} } });
		const events = getState().events;
		expect(events.length).toBe(500);
		// first 20 evicted; oldest surviving summary is "20"
		expect(events[0].summary).toBe('20');
		expect(events[events.length - 1].summary).toBe('519');
	});

	test('RESET rewinds the id counter', () => {
		dispatch({ type: 'EVENT_LOGGED', entry: { direction: 'local', kind: 'k', summary: 's', details: {} } });
		dispatch({ type: 'RESET' });
		dispatch({ type: 'EVENT_LOGGED', entry: { direction: 'local', kind: 'k', summary: 's', details: {} } });
		expect(getState().events[0].id).toBe(1);
	});
});

describe('ui', () => {
	test('SIDEBAR_TOGGLE: open → switch section → close', () => {
		dispatch({ type: 'SIDEBAR_TOGGLE', section: 'verify' });
		expect(getState().ui).toMatchObject({ sidebarOpen: true, activeSection: 'verify' });
		dispatch({ type: 'SIDEBAR_TOGGLE', section: 'event-log' });
		expect(getState().ui).toMatchObject({ sidebarOpen: true, activeSection: 'event-log' });
		dispatch({ type: 'SIDEBAR_TOGGLE', section: 'event-log' });
		expect(getState().ui.sidebarOpen).toBe(false);
	});

	test('SIDEBAR_RESIZE sets width pct', () => {
		expect(getState().ui.sidebarWidthPct).toBe(SIDEBAR_DEFAULTS.DEFAULT_PCT);
		dispatch({ type: 'SIDEBAR_RESIZE', pct: 55 });
		expect(getState().ui.sidebarWidthPct).toBe(55);
	});

	test('SYSTEM_TOGGLE flips hideSystem', () => {
		expect(getState().ui.hideSystem).toBe(false);
		dispatch({ type: 'SYSTEM_TOGGLE' });
		expect(getState().ui.hideSystem).toBe(true);
		dispatch({ type: 'SYSTEM_TOGGLE' });
		expect(getState().ui.hideSystem).toBe(false);
	});
});

describe('RESET', () => {
	test('clears peers, messages, events, fingerprint and returns to landing', () => {
		dispatch({ type: 'PEER_ADDED', username: 'a', fingerprint: fp('aa') });
		dispatch({ type: 'MESSAGE_APPENDED', item: { kind: 'message', from: 'a', text: 'hi', isSelf: false, ts: 1 } });
		dispatch({ type: 'LOCAL_FINGERPRINT', fingerprint: fp('dd') });
		dispatch({ type: 'RESET' });
		const s = getState();
		expect(s.screen.name).toBe('landing');
		expect(s.peers.size).toBe(0);
		expect(s.messages).toHaveLength(0);
		expect(s.events).toHaveLength(0);
		expect(s.localFingerprint).toBeUndefined();
	});
});

describe('subscribe', () => {
	test('fires on every dispatch and unsubscribe stops it', () => {
		let count = 0;
		const off = subscribe(() => count++);
		dispatch({ type: 'SYSTEM_TOGGLE' });
		dispatch({ type: 'SYSTEM_TOGGLE' });
		expect(count).toBe(2);
		off();
		dispatch({ type: 'SYSTEM_TOGGLE' });
		expect(count).toBe(2);
	});
});
