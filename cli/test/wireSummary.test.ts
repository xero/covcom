import { describe, expect, test } from 'bun:test';
import { redact, summarizeInbound, summarizeOutbound } from '../src/wireSummary.ts';
import type { InboundMsg, OutboundMsg } from '../src/ws.ts';

describe('redact', () => {
	test('empty / nullish renders as ∅', () => {
		expect(redact(undefined)).toBe('∅');
		expect(redact(null)).toBe('∅');
		expect(redact('')).toBe('∅');
	});

	test('reports decoded byte length and an 8-char head', () => {
		expect(redact('Zm9vYmFy')).toBe('6B "Zm9vYmFy…"');     // 8 b64 chars, no padding → 6 bytes
		expect(redact('YQ==')).toBe('1B "YQ==…"');             // one byte, double padding
	});
});

describe('summarizeInbound', () => {
	test('room_created redacts the secret', () => {
		const r = summarizeInbound({ type: 'room_created', roomId: 'R1', roomSecret: 'Zm9vYmFy' } as InboundMsg);
		expect(r.summary).toBe('room created R1');
		expect(r.details.roomId).toBe('R1');
		expect(r.details.roomSecret).toBe('6B "Zm9vYmFy…"');
	});

	test('joined pluralizes member count', () => {
		const one = summarizeInbound({ type: 'joined', members: [{ username: 'a', ek: '', ratchetEk: '', claim: '' }] } as InboundMsg);
		expect(one.summary).toBe('joined room (1 existing member)');
		const two = summarizeInbound({ type: 'joined', members: [
			{ username: 'a', ek: '', ratchetEk: '', claim: '' },
			{ username: 'b', ek: '', ratchetEk: '', claim: '' },
		] } as InboundMsg);
		expect(two.summary).toBe('joined room (2 existing members)');
		expect(two.details.usernames).toBe('a, b');
	});

	test('broadcast flattens meta under meta.* keys', () => {
		const r = summarizeInbound({ type: 'broadcast', from: 'bob', payload: 'Zm9v', sig: 'YQ==', meta: { type: 'chat', n: 3 } } as InboundMsg);
		expect(r.summary).toBe('bob broadcast (chat)');
		expect(r.details.from).toBe('bob');
		expect(r.details['meta.type']).toBe('chat');
		expect(r.details['meta.n']).toBe(3);
	});

	test('error surfaces the reason', () => {
		expect(summarizeInbound({ type: 'error', reason: 'room_full' } as InboundMsg).summary).toBe('server error: room_full');
	});
});

describe('summarizeOutbound', () => {
	test('create marks admin token presence', () => {
		expect(summarizeOutbound({ type: 'create' } as OutboundMsg).details.adminToken).toBe('∅');
		expect(summarizeOutbound({ type: 'create', adminToken: 't' } as OutboundMsg).details.adminToken).toBe('✓');
	});

	test('identify summarizes by username', () => {
		const r = summarizeOutbound({ type: 'identify', username: 'alice', ek: 'Zm9v', ratchetEk: '', claim: '' } as OutboundMsg);
		expect(r.summary).toBe('identify as alice');
		expect(r.details.username).toBe('alice');
	});

	test('ratchet_step counts peers and flattens per-peer payloads', () => {
		const r = summarizeOutbound({
			type: 'ratchet_step',
			payloads: { bob: { kemCt: 'Zm9v', encSeed: 'YmFy', pn: 7 } },
			newEk: '', payload: '', meta: {}, sig: '', claim: '',
		} as OutboundMsg);
		expect(r.summary).toBe('ratchet step → 1 peer');
		expect(r.details['payloads.bob.pn']).toBe(7);
		expect(r.details['payloads.bob.kemCt']).toBe('3B "Zm9v…"');
	});
});
