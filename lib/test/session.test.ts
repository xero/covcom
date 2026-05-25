import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { KDFChain, SkippedKeyStore } from 'leviathan-crypto';
import { initCrypto } from '../src/init.js';
import { generateKeypair } from '../src/keypair.js';
import { Session } from '../src/session.js';
import { wipe } from '../src/wipe.js';

beforeAll(async () => {
	await initCrypto();
});

const enc = new TextEncoder();
const dec = new TextDecoder();

// Helper: create N sessions and perform full cross-handshake
function makeParty(n: number, roomId?: string): Session[] {
	const kps      = Array.from({ length: n }, generateKeypair);
	const sessions = kps.map(kp => new Session(kp, roomId));
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < n; j++) {
			if (i === j) continue;
			sessions[j].unwrapChainSeed(
				`p${i}`,
				sessions[i].wrapChainSeedFor(sessions[j].ek, `p${j}`),
			);
		}
	}
	for (let i = 0; i < n; i++)
		for (let j = 0; j < n; j++) {
			if (i === j) continue;
			sessions[i].updatePeerRatchetEk(`p${j}`, sessions[j].ratchetEk);
		}
	return sessions;
}

describe('session: N=2 handshake and messaging', () => {
	test('1. basic seal/open round-trip', () => {
		const [sA, sB] = makeParty(2);
		const plain = enc.encode('hello world');
		const { ciphertext, counter } = sA.sealMessage(plain);
		expect(counter).toBe(1);
		const decrypted = sB.openMessage('p0', 0, counter, ciphertext);
		expect(dec.decode(decrypted)).toBe('hello world');
		sA.dispose();
		sB.dispose();
	});

	test('2. counter increments', () => {
		const [sA] = makeParty(2);
		const { counter: c1 } = sA.sealMessage(enc.encode('a'));
		const { counter: c2 } = sA.sealMessage(enc.encode('b'));
		const { counter: c3 } = sA.sealMessage(enc.encode('c'));
		expect(c1).toBe(1);
		expect(c2).toBe(2);
		expect(c3).toBe(3);
		sA.dispose();
	});

	test('3. bidirectional', () => {
		const [sA, sB] = makeParty(2);
		const { ciphertext: ctAB, counter: cAB } = sA.sealMessage(enc.encode('from A'));
		expect(dec.decode(sB.openMessage('p0', 0, cAB, ctAB))).toBe('from A');

		const { ciphertext: ctBA, counter: cBA } = sB.sealMessage(enc.encode('from B'));
		expect(dec.decode(sA.openMessage('p1', 0, cBA, ctBA))).toBe('from B');

		sA.dispose();
		sB.dispose();
	});
});

describe('session: out-of-order delivery', () => {
	test('4. in-order delivery, MKSKIPPED empty after all', () => {
		const [sA, sB] = makeParty(2);
		const msgs = [1, 2, 3].map(i => sA.sealMessage(enc.encode(`msg${i}`)));
		for (const { ciphertext, counter } of msgs) sB.openMessage('p0', 0, counter, ciphertext);

		const store = (sB as unknown as {
			_senderState: Map<string, { store: { size: number } }>
		})._senderState.get('p0')?.store;
		expect(store?.size ?? 0).toBe(0);

		sA.dispose();
		sB.dispose();
	});

	test('5. single gap: MKSKIPPED holds correct keys', () => {
		const [sA, sB] = makeParty(2);
		const { ciphertext: ct1 } = sA.sealMessage(enc.encode('one'));
		const { ciphertext: ct2 } = sA.sealMessage(enc.encode('two'));
		const { ciphertext: ct3, counter: c3 } = sA.sealMessage(enc.encode('three'));

		// Receive 3 first
		expect(dec.decode(sB.openMessage('p0', 0, c3, ct3))).toBe('three');

		const store = (sB as unknown as {
			_senderState: Map<string, { store: { size: number; _store: Map<number, Uint8Array> } }>
		})._senderState.get('p0')!.store;
		expect(store.size).toBe(2);
		expect(store._store.has(1)).toBe(true);
		expect(store._store.has(2)).toBe(true);

		// Receive 1, then 2; both from MKSKIPPED
		expect(dec.decode(sB.openMessage('p0', 0, 1, ct1))).toBe('one');
		expect(dec.decode(sB.openMessage('p0', 0, 2, ct2))).toBe('two');
		expect(store.size).toBe(0);

		sA.dispose();
		sB.dispose();
	});

	test('6. gap then in-order GC', () => {
		const [sA, sB] = makeParty(2);
		const sealed = Array.from({ length: 10 }, (_, i) => sA.sealMessage(enc.encode(`m${i + 1}`)));

		// Receive counter 5 first
		sB.openMessage('p0', 0, sealed[4].counter, sealed[4].ciphertext);
		const store = (sB as unknown as {
			_senderState: Map<string, { store: { size: number } }>
		})._senderState.get('p0')!.store;
		expect(store.size).toBe(4); // counters 1-4

		// Receive 1 through 4 from MKSKIPPED
		for (let i = 0; i < 4; i++) {
			sB.openMessage('p0', 0, sealed[i].counter, sealed[i].ciphertext);
		}
		expect(store.size).toBe(0);

		// Receive 6-10 in order
		for (let i = 5; i < 10; i++) {
			sB.openMessage('p0', 0, sealed[i].counter, sealed[i].ciphertext);
		}

		sA.dispose();
		sB.dispose();
	});

	test('7. ceiling enforcement: skip > maxSkipPerResolve throws; accumulated skips fit cache', () => {
		const [sA, sB] = makeParty(2);

		// SkippedKeyStore throws when a single resolve's skip window exceeds
		// maxSkipPerResolve (default 50). Seal 52 messages; skip to counter 52
		// = window 51 > 50 → throws.
		const sealed52 = Array.from({ length: 52 }, (_, i) =>
			sA.sealMessage(enc.encode(`m${i + 1}`)),
		);
		expect(() => sB.openMessage('p0', 0, sealed52[51].counter, sealed52[51].ciphertext)).toThrow();

		// Accumulated skip across two resolves, each within the per-resolve cap.
		// First skip (0→30): window=29 ≤ 50, stores 1-29 (29 entries).
		// Second skip (30→50): window=19 ≤ 50, stores 31-49 (19 more).
		// Total stored = 48 ≤ maxCacheSize=100. No eviction; both succeed.
		const [sA2, sB2] = makeParty(2);
		const sealed50 = Array.from({ length: 50 }, (_, i) =>
			sA2.sealMessage(enc.encode(`m${i + 1}`)),
		);
		sB2.openMessage('p0', 0, sealed50[29].counter, sealed50[29].ciphertext); // counter 30
		sB2.openMessage('p0', 0, sealed50[49].counter, sealed50[49].ciphertext); // counter 50

		const store = (sB2 as unknown as {
			_senderState: Map<string, { store: { size: number } }>
		})._senderState.get('p0')!.store;
		expect(store.size).toBe(48); // 29 + 19 skipped keys stored

		sA.dispose();
		sB.dispose();
		sA2.dispose();
		sB2.dispose();
	});

	test('8. unrecoverable message throws', () => {
		const [sA, sB] = makeParty(2);

		// Seal 3 messages; B gets counter 3 (stores 1 and 2 in MKSKIPPED)
		sA.sealMessage(enc.encode('one'));
		sA.sealMessage(enc.encode('two'));
		const { ciphertext: ct3, counter: c3 } = sA.sealMessage(enc.encode('three'));
		sB.openMessage('p0', 0, c3, ct3);

		// Dispose B; create a fresh session, no chains established
		sB.dispose();
		const kpB2 = generateKeypair();
		const sB2 = new Session(kpB2);

		expect(() => sB2.openMessage('p0', 0, 1, ct3)).toThrow();
		sA.dispose();
		sB2.dispose();
	});
});

describe('session: N=5', () => {
	test('9. five-party handshake: participant 0 broadcasts', () => {
		const sessions = makeParty(5);
		const { ciphertext, counter } = sessions[0].sealMessage(enc.encode('hello all'));
		for (let i = 1; i < 5; i++) {
			expect(dec.decode(sessions[i].openMessage('p0', 0, counter, ciphertext))).toBe('hello all');
		}
		for (const s of sessions) s.dispose();
	});

	test('10. five-party independent chains: all 20 decryptions succeed', () => {
		const sessions = makeParty(5);
		// Each participant seals one message
		const sealed = sessions.map((s, i) => ({
			...s.sealMessage(enc.encode(`from p${i}`)),
			senderIdx: i,
		}));
		// Every other participant opens each message
		for (const { ciphertext, counter, senderIdx } of sealed) {
			for (let i = 0; i < 5; i++) {
				if (i === senderIdx) continue;
				const plain = sessions[i].openMessage(`p${senderIdx}`, 0, counter, ciphertext);
				expect(dec.decode(plain)).toBe(`from p${senderIdx}`);
			}
		}
		for (const s of sessions) s.dispose();
	});
});

describe('session: teardown', () => {
	test('11. dispose wipes key material', () => {
		const [sA, sB] = makeParty(2);
		// Confirm functional
		const { ciphertext, counter } = sA.sealMessage(enc.encode('test'));
		sB.openMessage('p0', 0, counter, ciphertext);

		sA.dispose();
		expect(sA.disposed).toBe(true);
		expect(() => sA.sealMessage(enc.encode('after dispose'))).toThrow();
		// Double dispose must not throw
		expect(() => sA.dispose()).not.toThrow();

		sB.dispose();
	});

	test('12. dispose zeroes chain seed buffer', () => {
		const kp = generateKeypair();
		const s = new Session(kp);
		const seedRef = s.chainSeed; // reference to the internal buffer

		// Verify seed is non-zero before dispose
		expect(seedRef.some(b => b !== 0)).toBe(true);

		s.dispose();

		// wipe() zeroes the buffer in place; seedRef still points to it
		expect(seedRef.every(b => b === 0)).toBe(true);
	});
});

describe('session: sealFileKey', () => {
	test('21. sealFileKey steps chain and shares counter with sealMessage', () => {
		const [sA] = makeParty(2);
		const { msgKey, counter: c1 } = sA.sealFileKey();
		expect(msgKey.length).toBe(32);
		expect(c1).toBe(1);
		wipe(msgKey);
		const { counter: c2 } = sA.sealMessage(enc.encode('after file key'));
		expect(c2).toBe(2);
		sA.dispose();
	});
});

describe('session: ratchet step', () => {
	test('13. ratchet step: initiator advances to epoch 1, receiver stays at epoch 0', () => {
		const [sA, sB] = makeParty(2);

		// A initiates ratchet step toward B, then commits
		const { kemCt, encSeed, pn } = sA.performRatchetStep('p1');
		sA.commitRatchetStep();

		// B processes the step
		sB.receiveRatchetStep('p0', kemCt, encSeed, pn);

		// A seals at epoch 1; B opens at epoch 1
		const { ciphertext: ct1, counter: c1, epoch: e1 } = sA.sealMessage(enc.encode('epoch1 from A'));
		expect(e1).toBe(1);
		expect(dec.decode(sB.openMessage('p0', 1, c1, ct1))).toBe('epoch1 from A');

		// B seals at epoch 0 (B has not ratcheted); A opens at epoch 0
		const { ciphertext: ct2, counter: c2, epoch: e2 } = sB.sealMessage(enc.encode('epoch0 from B'));
		expect(e2).toBe(0);
		expect(dec.decode(sA.openMessage('p1', 0, c2, ct2))).toBe('epoch0 from B');

		sA.dispose();
		sB.dispose();
	});

	test('14. late epoch-0 delivery after epoch-1 active', () => {
		const [sA, sB] = makeParty(2);

		// Seal a message at epoch 0 before the ratchet step
		const { ciphertext: ct0, counter: c0 } = sA.sealMessage(enc.encode('pre-ratchet'));

		// Complete the ratchet step
		const { kemCt, encSeed, pn } = sA.performRatchetStep('p1');
		sA.commitRatchetStep();
		sB.receiveRatchetStep('p0', kemCt, encSeed, pn);

		// Now open the epoch-0 message; must succeed from old state
		expect(dec.decode(sB.openMessage('p0', 0, c0, ct0))).toBe('pre-ratchet');

		sA.dispose();
		sB.dispose();
	});

	test('15. N=3 all pairs step: initiator at epoch 1, receiver stays at epoch 0', () => {
		// Test each pair independently: 3 pairs × 2 directions = 6 combinations.
		// After the step, si is at epoch 1; sj stays at epoch 0 (has not ratcheted).
		for (let p = 0; p < 3; p++) {
			const [si, sj] = makeParty(2);
			const { kemCt, encSeed, pn } = si.performRatchetStep('p1');
			si.commitRatchetStep();
			sj.receiveRatchetStep('p0', kemCt, encSeed, pn);

			const { ciphertext: ctI, counter: cI, epoch: eI } = si.sealMessage(enc.encode(`pair${p} i→j`));
			expect(eI).toBe(1);
			expect(dec.decode(sj.openMessage('p0', 1, cI, ctI))).toBe(`pair${p} i→j`);

			const { ciphertext: ctJ, counter: cJ, epoch: eJ } = sj.sealMessage(enc.encode(`pair${p} j→i`));
			expect(eJ).toBe(0);
			expect(dec.decode(si.openMessage('p1', 0, cJ, ctJ))).toBe(`pair${p} j→i`);

			si.dispose();
			sj.dispose();
		}
	});

	test('17. N=3 ratchet step: shared seed, B and C both decrypt', () => {
		const [sA, sB, sC] = makeParty(3);

		// A performs step toward B and C, then commits
		const { kemCt: kemB, encSeed: esB, pn: pnB } = sA.performRatchetStep('p1');
		const { kemCt: kemC, encSeed: esC, pn: pnC } = sA.performRatchetStep('p2');
		sA.commitRatchetStep();

		// pn must be the same for both peers (captured before any chain advancement)
		expect(pnB).toBe(pnC);

		// B and C each process their step
		sB.receiveRatchetStep('p0', kemB, esB, pnB);
		sC.receiveRatchetStep('p0', kemC, esC, pnC);

		// A seals at epoch 1
		const { ciphertext, counter, epoch } = sA.sealMessage(enc.encode('epoch1 to all'));
		expect(epoch).toBe(1);

		// BOTH B and C must decrypt successfully with the same ciphertext
		expect(dec.decode(sB.openMessage('p0', 1, counter, ciphertext))).toBe('epoch1 to all');
		expect(dec.decode(sC.openMessage('p0', 1, counter, ciphertext))).toBe('epoch1 to all');

		// B and C stay at epoch 0; they have not ratcheted
		const { ciphertext: ct2, counter: c2, epoch: e2 } = sB.sealMessage(enc.encode('epoch0 from B'));
		expect(e2).toBe(0);
		expect(dec.decode(sA.openMessage('p1', 0, c2, ct2))).toBe('epoch0 from B');

		const { ciphertext: ct3, counter: c3, epoch: e3 } = sC.sealMessage(enc.encode('epoch0 from C'));
		expect(e3).toBe(0);
		expect(dec.decode(sA.openMessage('p2', 0, c3, ct3))).toBe('epoch0 from C');

		sA.dispose(); sB.dispose(); sC.dispose();
	});

	test('18. commitRatchetStep throws if no pending step', () => {
		const [sA] = makeParty(2);
		expect(() => sA.commitRatchetStep()).toThrow();
		sA.dispose();
	});

	test('19. dispose wipes _pendingRatchetSeed', () => {
		const [sA, sB] = makeParty(2);
		// start a step but don't commit
		sA.performRatchetStep('p1');
		const ref = (sA as unknown as { _pendingRatchetSeed: Uint8Array | null });
		expect(ref._pendingRatchetSeed).not.toBeNull();
		sA.dispose();
		expect(ref._pendingRatchetSeed).toBeNull();
		sB.dispose();
	});

	test('20. _oldSenderState pruning: epoch N-3 evicted after 3 ratchet steps', () => {
		const [sA, sB] = makeParty(2);

		// perform 3 ratchet steps: sB advances senderState['p0'] to epoch 3
		for (let i = 0; i < 3; i++) {
			const { kemCt, encSeed, pn } = sA.performRatchetStep('p1');
			sA.commitRatchetStep();
			sB.receiveRatchetStep('p0', kemCt, encSeed, pn);
			sA.updatePeerRatchetEk('p1', sB.ratchetEk);
		}

		// sB._senderState['p0'].epoch === 3
		// _oldSenderState['p0'] should have epochs 1, 2 (keep N-2=1 and N-1=2)
		// epoch 0 should have been pruned
		interface AnySession {
			_oldSenderState: Map<string, Map<number, unknown>>
			_senderState:    Map<string, { epoch: number }>
		}
		const ref = sB as unknown as AnySession;
		const epochMap = ref._oldSenderState.get('p0')!;
		expect(ref._senderState.get('p0')!.epoch).toBe(3);
		expect(epochMap.has(0)).toBe(false);  // pruned
		expect(epochMap.has(1)).toBe(true);   // kept (N-2)
		expect(epochMap.has(2)).toBe(true);   // kept (N-1)

		sA.dispose(); sB.dispose();
	});

	test('21. _resolveKey error messages: future epoch, too old, key not found', () => {
		const [sA, sB] = makeParty(2);
		const enc2 = new TextEncoder();

		// seed a message at epoch 0 counter 1
		const { ciphertext, counter } = sA.sealMessage(enc2.encode('msg'));

		// future epoch error
		expect(() => sB.openMessage('p0', 1, counter, ciphertext))
			.toThrow('future epoch');

		// advance sB past the keep window (3 ratchet steps)
		for (let i = 0; i < 3; i++) {
			const { kemCt, encSeed, pn } = sA.performRatchetStep('p1');
			sA.commitRatchetStep();
			sB.receiveRatchetStep('p0', kemCt, encSeed, pn);
			sA.updatePeerRatchetEk('p1', sB.ratchetEk);
		}

		// too old error, epoch 0 has been pruned
		expect(() => sB.openMessage('p0', 0, counter, ciphertext))
			.toThrow('too old');

		sA.dispose(); sB.dispose();
	});

	test('16. dispose wipes new fields', () => {
		const [sA, sB] = makeParty(2);

		// Perform a ratchet step so all maps are populated
		const { kemCt, encSeed, pn } = sA.performRatchetStep('p1');
		sA.commitRatchetStep();
		sB.receiveRatchetStep('p0', kemCt, encSeed, pn);
		sA.dispose();

		interface AnySession {
			_encapRoots:     Map<unknown, unknown>
			_decapRoots:     Map<unknown, unknown>
			_oldSenderState: Map<unknown, unknown>
			_senderState:    Map<unknown, unknown>
		}
		const ref = sA as unknown as AnySession;
		expect(ref._encapRoots.size).toBe(0);
		expect(ref._decapRoots.size).toBe(0);
		expect(ref._oldSenderState.size).toBe(0);
		expect(ref._senderState.size).toBe(0);

		sB.dispose();
	});
});

// Cleanup: ensure no lingering sessions after each test group
afterEach(() => {
	// Sessions are disposed within each test; nothing to do here
});

function advanceEpoch(
	initiator: Session,
	iName:     string,
	receiver:  Session,
	rName:     string,
	steps:     number,
): void {
	for (let i = 0; i < steps; i++) {
		const { kemCt, encSeed, pn } = initiator.performRatchetStep(rName);
		initiator.commitRatchetStep();
		receiver.receiveRatchetStep(iName, kemCt, encSeed, pn);
		initiator.updatePeerRatchetEk(rName, receiver.ratchetEk);
	}
}

describe('session: late-join epoch sync', () => {
	test('22. join at epoch N baseline', () => {
		const [sA, sB] = makeParty(2);
		advanceEpoch(sA, 'p0', sB, 'p1', 2);

		const xeroKp = generateKeypair();
		const xero   = new Session(xeroKp);
		const blob   = sA.wrapChainSeedFor(xero.ek, 'xero');
		xero.unwrapChainSeed('p0', blob);

		interface Ref { _senderState: Map<string, { epoch: number }> }
		expect((xero as unknown as Ref)._senderState.get('p0')!.epoch).toBe(2);

		const { ciphertext, counter, epoch } = sA.sealMessage(enc.encode('late join test'));
		expect(epoch).toBe(2);
		expect(dec.decode(xero.openMessage('p0', 2, counter, ciphertext))).toBe('late join test');

		sA.dispose(); sB.dispose(); xero.dispose();
	});

	test('23. non-regression: epoch 0 join identical to v2', () => {
		const [sA, sB] = makeParty(2);

		interface Ref { _senderState: Map<string, { epoch: number }> }
		expect((sB as unknown as Ref)._senderState.get('p0')!.epoch).toBe(0);
		expect((sA as unknown as Ref)._senderState.get('p1')!.epoch).toBe(0);

		const { ciphertext: ctAB, counter: cAB, epoch: eAB } = sA.sealMessage(enc.encode('a to b'));
		expect(eAB).toBe(0);
		expect(dec.decode(sB.openMessage('p0', 0, cAB, ctAB))).toBe('a to b');

		const { ciphertext: ctBA, counter: cBA, epoch: eBA } = sB.sealMessage(enc.encode('b to a'));
		expect(eBA).toBe(0);
		expect(dec.decode(sA.openMessage('p1', 0, cBA, ctBA))).toBe('b to a');

		sA.dispose(); sB.dispose();
	});

	test('24. multiple late joiners at different epochs', () => {
		const [sA, sB] = makeParty(2);
		advanceEpoch(sA, 'p0', sB, 'p1', 1);
		advanceEpoch(sB, 'p1', sA, 'p0', 2);

		const xeroKp = generateKeypair();
		const xero   = new Session(xeroKp);

		const aliceBlob = sA.wrapChainSeedFor(xero.ek, 'xero');
		xero.unwrapChainSeed('alice', aliceBlob);
		xero.updatePeerRatchetEk('alice', sA.ratchetEk);

		const bobBlob = sB.wrapChainSeedFor(xero.ek, 'xero');
		xero.unwrapChainSeed('bob', bobBlob);
		xero.updatePeerRatchetEk('bob', sB.ratchetEk);

		const { ciphertext: ctA, counter: cA, epoch: eA } = sA.sealMessage(enc.encode('alice epoch 1'));
		expect(eA).toBe(1);
		expect(dec.decode(xero.openMessage('alice', 1, cA, ctA))).toBe('alice epoch 1');

		const { ciphertext: ctB, counter: cB, epoch: eB } = sB.sealMessage(enc.encode('bob epoch 2'));
		expect(eB).toBe(2);
		expect(dec.decode(xero.openMessage('bob', 2, cB, ctB))).toBe('bob epoch 2');

		sA.dispose(); sB.dispose(); xero.dispose();
	});

	test('25. late-joiner-then-ratchet-again (root consistency)', () => {
		const [sA, sB] = makeParty(2);
		advanceEpoch(sA, 'p0', sB, 'p1', 2);

		const xeroKp = generateKeypair();
		const xero   = new Session(xeroKp);

		const aliceBlob = sA.wrapChainSeedFor(xero.ek, 'xero');
		xero.unwrapChainSeed('alice', aliceBlob);
		xero.updatePeerRatchetEk('alice', sA.ratchetEk);

		const xeroBlob = xero.wrapChainSeedFor(sA.ek, 'alice');
		sA.unwrapChainSeed('xero', xeroBlob);
		sA.updatePeerRatchetEk('xero', xero.ratchetEk);

		const { kemCt, encSeed, pn } = xero.performRatchetStep('alice');
		xero.commitRatchetStep();
		sA.receiveRatchetStep('xero', kemCt, encSeed, pn);
		xero.updatePeerRatchetEk('alice', sA.ratchetEk);

		const { ciphertext: ctX, counter: cX, epoch: eX } = xero.sealMessage(enc.encode('xero epoch 1'));
		expect(eX).toBe(1);
		expect(dec.decode(sA.openMessage('xero', 1, cX, ctX))).toBe('xero epoch 1');

		const { ciphertext: ctA, counter: cA, epoch: eA } = sA.sealMessage(enc.encode('alice epoch 2'));
		expect(eA).toBe(2);
		expect(dec.decode(xero.openMessage('alice', 2, cA, ctA))).toBe('alice epoch 2');

		sA.dispose(); sB.dispose(); xero.dispose();
	});

	test('26. wrapChainSeedFor called twice same peer: old root wiped', () => {
		interface Ref { _encapRoots: Map<string, Uint8Array> }
		const [sA, sB] = makeParty(2);
		const oldRoot = (sA as unknown as Ref)._encapRoots.get('p1')!;
		sA.wrapChainSeedFor(sB.ek, 'p1');
		expect(oldRoot.every(b => b === 0)).toBe(true);
		expect((sA as unknown as Ref)._encapRoots.get('p1')!.some(b => b !== 0)).toBe(true);
		sA.dispose(); sB.dispose();
	});

	test('27. unwrapChainSeed called twice same sender: old decapRoot wiped', () => {
		interface Ref { _decapRoots: Map<string, Uint8Array> }
		const [sA, sB] = makeParty(2);
		const oldDr  = (sB as unknown as Ref)._decapRoots.get('p0')!;
		const newBlob = sA.wrapChainSeedFor(sB.ek, 'p0');
		sB.unwrapChainSeed('p0', newBlob);
		expect(oldDr.every(b => b === 0)).toBe(true);
		const { ciphertext, counter, epoch } = sA.sealMessage(enc.encode('still works'));
		expect(dec.decode(sB.openMessage('p0', epoch, counter, ciphertext))).toBe('still works');
		sA.dispose(); sB.dispose();
	});
});

describe('room context chain separation', () => {
	test('sender and receiver derive matching keys with non-null roomId', () => {
		const [sA, sB] = makeParty(2, 'room-test');
		const plain = enc.encode('hello with room context');
		const { ciphertext, counter, epoch } = sA.sealMessage(plain);
		expect(dec.decode(sB.openMessage('p0', epoch, counter, ciphertext))).toBe('hello with room context');
		sA.dispose();
		sB.dispose();
	});

	test('same seed, different roomId → different message keys', () => {
		const kpSender   = generateKeypair();
		const kpReceiver = generateKeypair();
		const sender = new Session(kpSender, 'room-a');

		// Wrap sender's epoch seed for a shared receiver keypair (same blob decrypts to same raw seed)
		const blob = sender.wrapChainSeedFor(kpReceiver.ek, 'recv');

		// Two receiver sessions using the same keypair, different roomId
		const recvA = new Session(kpReceiver, 'room-a');
		const recvB = new Session(kpReceiver, 'room-b');
		recvA.unwrapChainSeed('sender', blob);
		recvB.unwrapChainSeed('sender', blob);

		// Seal with room-a context
		const { ciphertext, counter, epoch } = sender.sealMessage(enc.encode('secret'));

		// recvA (matching roomId) must decrypt
		expect(() => recvA.openMessage('sender', epoch, counter, ciphertext)).not.toThrow();

		// recvB (different roomId) derives a different chain key → must fail
		expect(() => recvB.openMessage('sender', epoch, counter, ciphertext)).toThrow();

		sender.dispose(); recvA.dispose(); recvB.dispose();
	});
});

describe('session: removePeer', () => {
	test('28. removePeer clears all five maps', () => {
		const sessions = makeParty(3);
		sessions[0].removePeer('p1');

		interface Ref {
			_senderState:    Map<string, unknown>
			_oldSenderState: Map<string, unknown>
			_encapRoots:     Map<string, unknown>
			_decapRoots:     Map<string, unknown>
			_peerRatchetEks: Map<string, unknown>
		}
		const ref = sessions[0] as unknown as Ref;
		expect(ref._senderState.has('p1')).toBe(false);
		expect(ref._oldSenderState.has('p1')).toBe(false);
		expect(ref._encapRoots.has('p1')).toBe(false);
		expect(ref._decapRoots.has('p1')).toBe(false);
		expect(ref._peerRatchetEks.has('p1')).toBe(false);
		expect(ref._senderState.has('p2')).toBe(true);

		for (const s of sessions) s.dispose();
	});

	test('29. removePeer on absent username does not throw', () => {
		const sessions = makeParty(2);
		expect(() => sessions[0].removePeer('nobody')).not.toThrow();
		for (const s of sessions) s.dispose();
	});
});

describe('session: epoch and counter getters', () => {
	test('30. epoch getter tracks ratchet steps', () => {
		const [sA, sB] = makeParty(2);
		expect(sA.epoch).toBe(0);

		const { kemCt: k1, encSeed: e1, pn: p1 } = sA.performRatchetStep('p1');
		sA.commitRatchetStep();
		sB.receiveRatchetStep('p0', k1, e1, p1);
		sA.updatePeerRatchetEk('p1', sB.ratchetEk);
		expect(sA.epoch).toBe(1);

		for (let i = 0; i < 2; i++) {
			const { kemCt, encSeed, pn } = sA.performRatchetStep('p1');
			sA.commitRatchetStep();
			sB.receiveRatchetStep('p0', kemCt, encSeed, pn);
			sA.updatePeerRatchetEk('p1', sB.ratchetEk);
		}
		expect(sA.epoch).toBe(3);

		sA.dispose(); sB.dispose();
	});

	test('31. counter getter tracks sealed messages', () => {
		const [sA, sB] = makeParty(2);
		expect(sA.counter).toBe(0);

		const { counter: c1 } = sA.sealMessage(enc.encode('one'));
		expect(c1).toBe(1);
		expect(sA.counter).toBe(1);

		sA.sealMessage(enc.encode('two'));
		sA.sealMessage(enc.encode('three'));
		expect(sA.counter).toBe(3);

		const { kemCt, encSeed, pn } = sA.performRatchetStep('p1');
		sA.commitRatchetStep();
		sB.receiveRatchetStep('p0', kemCt, encSeed, pn);
		expect(sA.counter).toBe(0);

		sA.dispose(); sB.dispose();
	});
});

describe('SkippedKeyStore: config validation', () => {
	test('32. maxSkipPerResolve > maxCacheSize throws RangeError', () => {
		expect(() => new SkippedKeyStore({ maxCacheSize: 10, maxSkipPerResolve: 20 }))
			.toThrow(RangeError);
	});

	test('33. legacy ceiling option still accepted', () => {
		expect(() => new SkippedKeyStore({ ceiling: 200 })).not.toThrow();
	});
});

describe('SkippedKeyStore: ResolveHandle', () => {
	function makeChainAndStore(): { chain: KDFChain, store: SkippedKeyStore } {
		const chainKey = new Uint8Array(32);
		for (let i = 0; i < 32; i++) chainKey[i] = i + 1;
		return { chain: new KDFChain(chainKey), store: new SkippedKeyStore() };
	}

	test('34. commit() wipes the key: h.key access after commit throws', () => {
		const { chain, store } = makeChainAndStore();
		const h = store.resolve(chain, 1);
		const k = h.key;
		expect(k.some(b => b !== 0)).toBe(true);
		h.commit();
		expect(k.every(b => b === 0)).toBe(true);
		expect(() => h.key).toThrow();
		chain.dispose();
	});

	test('35. rollback() returns the key: same counter resolves to identical bytes', () => {
		const { chain, store } = makeChainAndStore();
		// skip-ahead to 2 stores key for counter 1
		const h2 = store.resolve(chain, 2);
		h2.commit();

		const first  = store.resolve(chain, 1);
		const before = first.key.slice();
		first.rollback();

		const second = store.resolve(chain, 1);
		expect(Array.from(second.key)).toEqual(Array.from(before));
		second.commit();
		chain.dispose();
	});

	test('36. double commit() throws', () => {
		const { chain, store } = makeChainAndStore();
		const h = store.resolve(chain, 1);
		h.commit();
		expect(() => h.commit()).toThrow();
		chain.dispose();
	});

	test('37. double rollback() throws', () => {
		const { chain, store } = makeChainAndStore();
		const h2 = store.resolve(chain, 2);
		h2.commit();
		const h = store.resolve(chain, 1);
		h.rollback();
		expect(() => h.rollback()).toThrow();
		chain.dispose();
	});

	test('38. commit() then rollback() throws', () => {
		const { chain, store } = makeChainAndStore();
		const h = store.resolve(chain, 1);
		h.commit();
		expect(() => h.rollback()).toThrow();
		chain.dispose();
	});
});
