import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { initCrypto } from '@covcom/lib';
import type { InvitePayload } from '@covcom/lib';
import { CovcomSession } from '../src/session.ts';
import type { SessionEvents } from '../src/session.ts';
import type { Room } from '../src/store.ts';
import { broker, installMockWebSocket, uninstallMockWebSocket, waitUntil } from './mock-ws.ts';

const SERVER = 'localhost:1337';

function b64(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

function inviteFor(room: Room): InvitePayload {
	return { version: 1, roomId: room.id, roomSecret: b64(room.secret), dns: room.dns };
}

interface Track {
	phases:  SessionEvents['phase'][];
	joined:  string[];
	known:   string[];
	left:    string[];
	msgs:    SessionEvents['message'][];
	infos:   SessionEvents['info'][];
	ratchet: SessionEvents['ratchet'][];
	lastRoom(): Room | undefined;
	ready(): boolean;
}

function track(s: CovcomSession): Track {
	const t: Track = {
		phases: [], joined: [], known: [], left: [], msgs: [], infos: [], ratchet: [],
		lastRoom() {
			return this.phases.length ? this.phases[this.phases.length - 1].room : undefined;
		},
		ready() {
			return this.phases.some(p => p.phase === 'ready');
		},
	};
	s.on('phase',       p => t.phases.push(p));
	s.on('peer-joined', p => t.joined.push(p.username));
	s.on('peer-known',  p => t.known.push(p.username));
	s.on('peer-left',   p => t.left.push(p.username));
	s.on('message',     p => t.msgs.push(p));
	s.on('info',        p => t.infos.push(p));
	s.on('ratchet',     p => t.ratchet.push(p));
	return t;
}

const live: CovcomSession[] = [];
function make(): CovcomSession {
	const s = new CovcomSession();
	live.push(s);
	return s;
}

// Brings up alice (creator) and bob (joiner) to a ready two-party session.
async function pair(): Promise<{ alice: CovcomSession; bob: CovcomSession; ta: Track; tb: Track }> {
	const alice = make();
	const ta    = track(alice);
	void alice.create({ server: SERVER, username: 'alice' });
	await waitUntil(() => ta.phases.some(p => p.phase === 'waiting'));
	const room = ta.lastRoom()!;

	const bob = make();
	const tb  = track(bob);
	void bob.join(inviteFor(room), 'bob');
	await waitUntil(() => ta.ready() && tb.ready());
	return { alice, bob, ta, tb };
}

beforeAll(async () => {
	await initCrypto();
});

beforeEach(() => installMockWebSocket());

afterEach(() => {
	for (const s of live.splice(0)) s.dispose();
	uninstallMockWebSocket();
});

describe('lifecycle', () => {
	test('create() walks joining → waiting and yields a room', async () => {
		const s = make();
		const t = track(s);
		void s.create({ server: SERVER, username: 'alice' });
		await waitUntil(() => t.phases.some(p => p.phase === 'waiting'));
		expect(t.phases.map(p => p.phase)).toEqual(['joining', 'waiting']);
		const room = t.lastRoom()!;
		expect(room.id.length).toBe(32);
		expect(room.secret).toBeInstanceOf(Uint8Array);
		expect(room.secret.length).toBe(16);
	});

	test('sendMessage returns false before the session is ready', () => {
		const s = make();
		expect(s.sendMessage('nope')).toBe(false);
	});
});

describe('two-party handshake', () => {
	test('both peers reach ready and learn each other', async () => {
		const { ta, tb } = await pair();
		expect(ta.ready()).toBe(true);
		expect(tb.ready()).toBe(true);
		expect(ta.joined).toContain('bob');
		expect(tb.joined).toContain('alice');
	});

	test('peers expose a fingerprint on join', async () => {
		const alice = make();
		const ta    = track(alice);
		void alice.create({ server: SERVER, username: 'alice' });
		await waitUntil(() => ta.phases.some(p => p.phase === 'waiting'));
		const bob = make();
		track(bob);
		let bobFp: string | undefined;
		alice.on('peer-joined', p => {
			bobFp = p.fingerprint.hex;
		});
		void bob.join(inviteFor(ta.lastRoom()!), 'bob');
		await waitUntil(() => bobFp !== undefined);
		expect(typeof bobFp).toBe('string');
		expect(bobFp!.length).toBeGreaterThan(0);
	});
});

describe('messaging', () => {
	test('a message encrypts on one side and decrypts on the other', async () => {
		const { alice, bob, ta, tb } = await pair();
		expect(alice.sendMessage('hello from alice')).toBe(true);
		await waitUntil(() => tb.msgs.some(m => m.text === 'hello from alice'));
		const got = tb.msgs.find(m => m.text === 'hello from alice')!;
		expect(got).toMatchObject({ from: 'alice', isSelf: false });

		expect(bob.sendMessage('hi back from bob')).toBe(true);
		await waitUntil(() => ta.msgs.some(m => m.text === 'hi back from bob'));
		expect(ta.msgs.find(m => m.text === 'hi back from bob')).toMatchObject({ from: 'bob', isSelf: false });
	});

	test('the sender sees its own message as isSelf', async () => {
		const { alice, ta } = await pair();
		alice.sendMessage('mine');
		const self = ta.msgs.find(m => m.text === 'mine');
		expect(self).toMatchObject({ from: 'alice', isSelf: true });
	});
});

describe('version mismatch', () => {
	test('older server (no serverVersion) drives fatal back to landing, never reaches waiting', async () => {
		broker.simulateOldServer = true;
		const s = make();
		const t = track(s);
		let fatal: SessionEvents['fatal'] | undefined;
		s.on('fatal', f => {
			fatal = f;
		});
		void s.create({ server: SERVER, username: 'alice' });
		await waitUntil(() => fatal !== undefined);
		expect(fatal!.reason).toBe('version_mismatch');
		expect(t.phases.some(p => p.phase === 'waiting')).toBe(false);
		expect(t.ready()).toBe(false);
	});
});

describe('teardown', () => {
	test('dispose() stops sends and notifies the peer', async () => {
		const { alice, bob, tb } = await pair();
		alice.dispose();
		expect(alice.sendMessage('after dispose')).toBe(false);
		await waitUntil(() => tb.left.includes('alice'));
		expect(tb.left).toContain('alice');
		// bob is still usable (no throw on a now-solo send attempt)
		expect(() => bob.sendMessage('still here')).not.toThrow();
	});
});
