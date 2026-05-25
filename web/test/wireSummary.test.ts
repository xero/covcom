import { describe, expect, test } from 'bun:test';
import { redact, summarizeInbound, summarizeOutbound } from '../src/wireSummary.ts';
import type { InboundMsg, OutboundMsg } from '../src/wireTypes.ts';

// A base64 string long enough that redact reports a non-trivial length.
const BLOB = 'QUFBQUFBQUE=';   // "AAAAAAAA"

describe('redact', () => {
	test('empty / nullish → ∅', () => {
		expect(redact(undefined)).toBe('∅');
		expect(redact(null)).toBe('∅');
		expect(redact('')).toBe('∅');
	});
	test('reports decoded byte length + truncated head', () => {
		// "QUFB" decodes to 3 bytes, no padding
		expect(redact('QUFB')).toBe('3B "QUFB…"');
	});
	test('accounts for base64 padding in the length', () => {
		// "QQ==" decodes to 1 byte
		expect(redact('QQ==')).toBe('1B "QQ==…"');
	});
});

describe('summarizeInbound', () => {
	test('peer_joined: username carried as a bold token, not HTML', () => {
		const { summary, details } = summarizeInbound({
			type: 'peer_joined', username: '<script>', ek: BLOB, ratchetEk: BLOB, claim: BLOB,
		} as InboundMsg);
		expect(summary).toEqual([{ b: '<script>' }, ' joined']);
		expect(details.username).toBe('<script>');
		// key material is redacted, never echoed verbatim
		expect(details.ek).toBe(redact(BLOB));
	});

	test('room_created: room id carried as a code token', () => {
		const { summary } = summarizeInbound({ type: 'room_created', roomId: 'abc', roomSecret: BLOB } as InboundMsg);
		expect(summary).toEqual(['room created ', { code: 'abc' }]);
	});

	test('joined: member count + redacted member material', () => {
		const { summary, details } = summarizeInbound({
			type: 'joined',
			members: [{ username: 'a', ek: BLOB, ratchetEk: BLOB, claim: BLOB }],
		} as InboundMsg);
		expect(summary).toBe('joined room (1 existing member)');
		expect(details.members).toBe(1);
		expect(details.usernames).toBe('a');
	});

	test('broadcast: flattens meta and redacts payload/sig', () => {
		const { summary, details } = summarizeInbound({
			type: 'broadcast', from: 'alice', payload: BLOB, sig: BLOB,
			meta: { type: 'message', counter: 4, epoch: 1 },
		} as InboundMsg);
		expect(summary).toEqual([{ b: 'alice' }, ' broadcast (message)']);
		expect(details.payload).toBe(redact(BLOB));
		expect(details['meta.counter']).toBe(4);
		expect(details['meta.epoch']).toBe(1);
	});

	test('error: surfaces the reason', () => {
		const { summary, details } = summarizeInbound({ type: 'error', reason: 'room_full' } as InboundMsg);
		expect(summary).toBe('server error: room_full');
		expect(details.reason).toBe('room_full');
	});

	test('unknown type falls back gracefully', () => {
		const { summary } = summarizeInbound({ type: 'bogus' } as unknown as InboundMsg);
		expect(summary).toBe('unknown inbound: bogus');
	});
});

describe('summarizeOutbound', () => {
	test('create: marks admin token presence without leaking it', () => {
		expect(summarizeOutbound({ type: 'create', adminToken: 'secret' } as OutboundMsg).details.adminToken).toBe('✓');
		expect(summarizeOutbound({ type: 'create' } as OutboundMsg).details.adminToken).toBe('∅');
	});

	test('identify: username bold token, key material redacted', () => {
		const { summary, details } = summarizeOutbound({
			type: 'identify', username: 'bob', ek: BLOB, ratchetEk: BLOB, claim: BLOB,
		} as OutboundMsg);
		expect(summary).toEqual(['identify as ', { b: 'bob' }]);
		expect(details.ek).toBe(redact(BLOB));
	});

	test('ratchet_step: peer count + flattened per-peer payloads', () => {
		const { summary, details } = summarizeOutbound({
			type: 'ratchet_step',
			payloads: { bob: { kemCt: BLOB, encSeed: BLOB, pn: 3 } },
			newEk: BLOB, payload: BLOB, sig: BLOB, claim: BLOB, meta: {},
		} as OutboundMsg);
		expect(summary).toBe('ratchet step → 1 peer');
		expect(details['payloads.bob.pn']).toBe(3);
		expect(details['payloads.bob.kemCt']).toBe(redact(BLOB));
	});

	test('unknown type falls back gracefully', () => {
		const { summary } = summarizeOutbound({ type: 'bogus' } as unknown as OutboundMsg);
		expect(summary).toBe('unknown outbound: bogus');
	});
});
