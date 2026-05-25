import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { initCrypto } from '../src/init.js';
import { SessionIdentity } from '../src/identity.js';

beforeAll(async () => {
	await initCrypto();
});

const ROOM = 'test-room-id-0001';

function pairBuildAccept(): { alice: SessionIdentity; bob: SessionIdentity; aliceFirstClaim: Uint8Array } {
	const alice = SessionIdentity.create();
	const bob   = SessionIdentity.create();
	const senderKey = new Uint8Array(32);
	senderKey.fill(0x42);
	const claim = alice.buildClaim(senderKey, 'alice', ROOM, 0);
	bob.acceptClaim('alice', claim);
	return { alice, bob, aliceFirstClaim: claim };
}

describe('SessionIdentity', () => {
	const created: SessionIdentity[] = [];

	afterEach(() => {
		for (const id of created.splice(0)) id.dispose();
	});

	test('claim build/verify round-trip', () => {
		const alice = SessionIdentity.create();
		const bob   = SessionIdentity.create();
		created.push(alice, bob);

		const senderKey = new Uint8Array(32).fill(0x11);
		const claim     = alice.buildClaim(senderKey, 'alice', ROOM, 0);
		const parsed    = bob.acceptClaim('alice', claim);

		expect(parsed.username).toBe('alice');
		expect(parsed.sequenceNum).toBe(0);
		expect(Array.from(parsed.senderKeyPub)).toEqual(Array.from(senderKey));
		expect(Array.from(parsed.sessionPk)).toEqual(Array.from(alice.sessionPk));
	});

	test('second claim chains off the first', () => {
		const alice = SessionIdentity.create();
		const bob   = SessionIdentity.create();
		created.push(alice, bob);

		const sk1   = new Uint8Array(32).fill(0x01);
		const sk2   = new Uint8Array(32).fill(0x02);
		const c0    = alice.buildClaim(sk1, 'alice', ROOM, 0);
		bob.acceptClaim('alice', c0);
		const c1    = alice.buildClaim(sk2, 'alice', ROOM, 1);
		const parsed = bob.acceptClaim('alice', c1);

		expect(parsed.sequenceNum).toBe(1);
		expect(parsed.epoch).toBe(1);
	});

	test('rejects mismatched sequenceNum', () => {
		const alice = SessionIdentity.create();
		const bob   = SessionIdentity.create();
		created.push(alice, bob);

		const sk = new Uint8Array(32).fill(0x33);
		const c0 = alice.buildClaim(sk, 'alice', ROOM, 0);
		bob.acceptClaim('alice', c0);
		alice.buildClaim(sk, 'alice', ROOM, 1);  // increments seq locally
		const c2 = alice.buildClaim(sk, 'alice', ROOM, 2);  // bob's view skips seq=1

		expect(() => bob.acceptClaim('alice', c2)).toThrow(/sequenceNum/);
	});

	test('rejects mismatched username vs claim', () => {
		const alice = SessionIdentity.create();
		const bob   = SessionIdentity.create();
		created.push(alice, bob);

		const sk    = new Uint8Array(32).fill(0x44);
		const claim = alice.buildClaim(sk, 'alice', ROOM, 0);
		expect(() => bob.acceptClaim('mallory', claim)).toThrow(/username mismatch/);
	});

	test('rejects forged claim from a different identity', () => {
		const alice   = SessionIdentity.create();
		const mallory = SessionIdentity.create();
		const bob     = SessionIdentity.create();
		created.push(alice, mallory, bob);

		const sk = new Uint8Array(32).fill(0x55);
		bob.acceptClaim('alice', alice.buildClaim(sk, 'alice', ROOM, 0));
		// Mallory tries to claim alice's identity in claim #1
		const forged = mallory.buildClaim(sk, 'alice', ROOM, 0);  // mallory's seq=0
		expect(() => bob.acceptClaim('alice', forged)).toThrow();
	});

	test('late joiner anchors on a peer claim at non-zero sequence', () => {
		// Alice has already ratcheted several times before Carol joins, so the
		// claim Carol first sees is at sequenceNum > 0. Carol must accept it as
		// her baseline and verify forward from there.
		const alice = SessionIdentity.create();
		const carol = SessionIdentity.create();
		created.push(alice, carol);

		const sk = new Uint8Array(32).fill(0x77);
		alice.buildClaim(sk, 'alice', ROOM, 0);   // seq 0, never seen by carol
		alice.buildClaim(sk, 'alice', ROOM, 1);   // seq 1, never seen by carol
		const established = alice.buildClaim(sk, 'alice', ROOM, 2);  // seq 2

		const baseline = carol.acceptClaim('alice', established);
		expect(baseline.sequenceNum).toBe(2);
		expect(carol.hasPeer('alice')).toBe(true);

		// forward continuity from the baseline still holds
		const next   = alice.buildClaim(sk, 'alice', ROOM, 3);
		const parsed = carol.acceptClaim('alice', next);
		expect(parsed.sequenceNum).toBe(3);
	});

	test('forward continuity still rejects a gap after a non-zero baseline', () => {
		const alice = SessionIdentity.create();
		const carol = SessionIdentity.create();
		created.push(alice, carol);

		const sk = new Uint8Array(32).fill(0x78);
		alice.buildClaim(sk, 'alice', ROOM, 0);
		alice.buildClaim(sk, 'alice', ROOM, 1);
		carol.acceptClaim('alice', alice.buildClaim(sk, 'alice', ROOM, 2));  // baseline seq 2
		alice.buildClaim(sk, 'alice', ROOM, 3);                              // carol misses seq 3
		const skipped = alice.buildClaim(sk, 'alice', ROOM, 4);
		expect(() => carol.acceptClaim('alice', skipped)).toThrow(/sequenceNum/);
	});

	test('first claim from a peer establishes their sessionPk', () => {
		const alice = SessionIdentity.create();
		const bob   = SessionIdentity.create();
		created.push(alice, bob);

		expect(bob.hasPeer('alice')).toBe(false);
		const claim = alice.buildClaim(new Uint8Array(32), 'alice', ROOM, 0);
		bob.acceptClaim('alice', claim);
		expect(bob.hasPeer('alice')).toBe(true);
	});

	test('signMessage / verifyMessage round-trip', () => {
		const { alice, bob } = pairBuildAccept();
		created.push(alice, bob);

		const ciphertext = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
		const ts         = Date.now();
		const sig        = alice.signMessage(7, 0, 'alice', ts, ciphertext);
		const ok         = bob.verifyMessage('alice', 7, 0, 'alice', ts, ciphertext, sig);
		expect(ok).toBe(true);
	});

	test('verifyMessage rejects tampered ciphertext', () => {
		const { alice, bob } = pairBuildAccept();
		created.push(alice, bob);

		const ciphertext = new Uint8Array([1, 2, 3, 4]);
		const ts         = Date.now();
		const sig        = alice.signMessage(1, 0, 'alice', ts, ciphertext);
		const tampered   = new Uint8Array([1, 2, 3, 5]);
		const ok         = bob.verifyMessage('alice', 1, 0, 'alice', ts, tampered, sig);
		expect(ok).toBe(false);
	});

	test('verifyMessage rejects wrong counter', () => {
		const { alice, bob } = pairBuildAccept();
		created.push(alice, bob);

		const ciphertext = new Uint8Array([9, 9, 9]);
		const ts         = Date.now();
		const sig        = alice.signMessage(5, 0, 'alice', ts, ciphertext);
		const ok         = bob.verifyMessage('alice', 6, 0, 'alice', ts, ciphertext, sig);
		expect(ok).toBe(false);
	});

	test('verifyMessage throws if no claim accepted yet', () => {
		const alice = SessionIdentity.create();
		const bob   = SessionIdentity.create();
		created.push(alice, bob);

		const sig = alice.signMessage(0, 0, 'alice', Date.now(), new Uint8Array([1]));
		expect(() => bob.verifyMessage('alice', 0, 0, 'alice', Date.now(), new Uint8Array([1]), sig)).toThrow(/no identity claim/);
	});

	test('localFingerprint is deterministic for the same pk', () => {
		const alice = SessionIdentity.create();
		created.push(alice);

		const fp1 = alice.localFingerprint();
		const fp2 = alice.localFingerprint();
		expect(fp1.hex).toBe(fp2.hex);
		expect(fp1.swatches).toEqual(fp2.swatches);
		expect(fp1.badge).toBe(fp2.badge);
	});

	test('fingerprint has 8 swatches, 16 hex chars, and one badge', () => {
		const alice = SessionIdentity.create();
		created.push(alice);

		const fp = alice.localFingerprint();
		expect(fp.swatches).toHaveLength(8);
		expect(fp.hex).toHaveLength(16);
		expect(fp.hex).toMatch(/^[0-9a-f]{16}$/);
		expect(fp.badge).toMatch(/^#[0-9a-f]{6}$/);
		for (const s of fp.swatches) expect(s).toMatch(/^#[0-9a-f]{6}$/);
	});

	test('peerFingerprint matches the peer\'s localFingerprint', () => {
		const { alice, bob } = pairBuildAccept();
		created.push(alice, bob);

		const aliceLocal = alice.localFingerprint();
		const peerView   = bob.peerFingerprint('alice');
		expect(peerView).not.toBeNull();
		expect(peerView!.hex).toBe(aliceLocal.hex);
		expect(peerView!.swatches).toEqual(aliceLocal.swatches);
	});

	test('peerFingerprint returns null for unknown peer', () => {
		const alice = SessionIdentity.create();
		created.push(alice);
		expect(alice.peerFingerprint('nobody')).toBeNull();
	});

	test('different sessionPks produce different fingerprints', () => {
		const alice = SessionIdentity.create();
		const bob   = SessionIdentity.create();
		created.push(alice, bob);
		expect(alice.localFingerprint().hex).not.toBe(bob.localFingerprint().hex);
	});

	test('OKLCh mapping is deterministic', () => {
		// Two identities with the same pk should map to the same colors. We can't
		// directly inject a pk, but we exercise determinism by hashing through twice.
		const alice = SessionIdentity.create();
		created.push(alice);
		const a = alice.localFingerprint();
		const b = alice.localFingerprint();
		expect(a.swatches).toEqual(b.swatches);
	});

	test('dispose disables further operations', () => {
		const alice = SessionIdentity.create();
		alice.dispose();
		expect(() => alice.buildClaim(new Uint8Array(32), 'a', ROOM, 0)).toThrow(/disposed/);
	});

	test('removePeer drops per-peer state', () => {
		const { alice, bob } = pairBuildAccept();
		created.push(alice, bob);
		expect(bob.hasPeer('alice')).toBe(true);
		bob.removePeer('alice');
		expect(bob.hasPeer('alice')).toBe(false);
	});

	test('claim payload preserves UTF-8 usernames', () => {
		const alice = SessionIdentity.create();
		const bob   = SessionIdentity.create();
		created.push(alice, bob);
		const claim  = alice.buildClaim(new Uint8Array(32), 'üser_😀_测试', ROOM, 0);
		const parsed = bob.acceptClaim('üser_😀_测试', claim);
		expect(parsed.username).toBe('üser_😀_测试');
	});

	test('rejects ctx mismatch (wrong-context blob)', () => {
		// Build a claim and then try to verify it under acceptClaim, but with a
		// tampered ctx byte in the envelope. Sign.verify should reject.
		const alice = SessionIdentity.create();
		const bob   = SessionIdentity.create();
		created.push(alice, bob);

		const claim = alice.buildClaim(new Uint8Array(32), 'alice', ROOM, 0);
		// Envelope layout: suite (1) | ctx_len (1) | ctx (N) | ...
		// Flip a byte inside ctx (offset 2 .. 2+ctx_len-1).
		const tampered = claim.slice();
		tampered[3] ^= 0xff;
		expect(() => bob.acceptClaim('alice', tampered)).toThrow();
	});
});
