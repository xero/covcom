import {
	KDFChain, MlKemSuite, MlKem768, Seal, XChaCha20Cipher,
	ratchetInit, kemRatchetEncap,
	SkippedKeyStore, RatchetKeypair,
} from 'leviathan-crypto';
import { wipe } from 'leviathan-crypto';
import type { ResolveHandle } from 'leviathan-crypto';
import type { KeyPair } from './types.js';
import { SessionIdentity } from './identity.js';

const EPOCH_KEEP_WINDOW = 2;

export class Session {
	private _ek:              Uint8Array;
	private _dk:              Uint8Array;
	private _kp:              RatchetKeypair;        // rotates after each decap
	private _chainSeed:       Uint8Array;
	private _myChain:         KDFChain;
	private _myEpoch:         number;                // starts 0
	private _currentEpochSeed: Uint8Array;

	// per-peer ratchet roots
	private _encapRoots:      Map<string, Uint8Array>;  // root key for encap toward peer
	private _decapRoots:      Map<string, Uint8Array>;  // root key for decap from peer

	// per-peer current ratchet ek (from identify / ek_update)
	private _peerRatchetEks:  Map<string, Uint8Array>;

	// shared seed and pn for a batched ratchet step (N≥3 correctness)
	private _pendingRatchetSeed: Uint8Array | null;
	private _pendingRatchetPn:   number;

	// current receive state per sender
	private _senderState: Map<string, {
		chain: KDFChain
		epoch: number
		store: SkippedKeyStore
	}>;

	// retired epoch state for late-arriving messages
	private _oldSenderState: Map<string, Map<number, {
		chain: KDFChain
		store: SkippedKeyStore
	}>>;

	private _roomCtx:  Uint8Array | undefined;
	private _roomId:   string;
	private _identity: SessionIdentity;
	private _disposed: boolean;

	constructor(keypair: KeyPair, roomId?: string) {
		this._ek              = keypair.ek;
		this._dk              = keypair.dk;
		this._kp              = new RatchetKeypair(new MlKem768());
		this._chainSeed        = crypto.getRandomValues(new Uint8Array(32));
		this._currentEpochSeed = this._chainSeed.slice();
		this._roomId           = roomId ?? '';
		this._roomCtx          = roomId ? new TextEncoder().encode(roomId) : undefined;
		const initResult       = ratchetInit(this._chainSeed, this._roomCtx);
		this._myChain          = new KDFChain(initResult.sendChainKey);
		wipe(initResult.sendChainKey);
		wipe(initResult.recvChainKey);
		wipe(initResult.nextRootKey);
		this._myEpoch         = 0;
		this._encapRoots      = new Map();
		this._decapRoots      = new Map();
		this._peerRatchetEks  = new Map();
		this._pendingRatchetSeed = null;
		this._pendingRatchetPn   = 0;
		this._senderState        = new Map();
		this._oldSenderState  = new Map();
		this._identity        = SessionIdentity.create();
		this._disposed        = false;
	}

	get ek(): Uint8Array         {
		return this._ek;
	}
	get ratchetEk(): Uint8Array  {
		return this._kp.ek;
	}
	get chainSeed(): Uint8Array  {
		return this._chainSeed;
	}
	get disposed(): boolean      {
		return this._disposed;
	}
	get epoch(): number          {
		return this._myEpoch;
	}
	get counter(): number        {
		return this._myChain.n;
	}
	get identity(): SessionIdentity {
		return this._identity;
	}
	get roomId(): string         {
		return this._roomId;
	}

	wrapChainSeedFor(peerEk: Uint8Array, peerUsername: string): Uint8Array {
		const suite  = MlKemSuite(new MlKem768(), XChaCha20Cipher);
		const plain  = new Uint8Array(36);
		new DataView(plain.buffer).setUint32(0, this._myEpoch, true); // 4B LE epoch
		plain.set(this._currentEpochSeed, 4);                         // 32B seed
		const blob = Seal.encrypt(suite, peerEk, plain);
		wipe(plain);

		const old = this._encapRoots.get(peerUsername);
		if (old) wipe(old);
		const init = ratchetInit(this._currentEpochSeed, this._roomCtx);
		this._encapRoots.set(peerUsername, init.nextRootKey);
		wipe(init.sendChainKey);
		wipe(init.recvChainKey);
		return blob;
	}

	unwrapChainSeed(senderUsername: string, blob: Uint8Array): void {
		const suite  = MlKemSuite(new MlKem768(), XChaCha20Cipher);
		const plain  = Seal.decrypt(suite, this._dk, blob);  // 36 bytes
		const epoch  = new DataView(plain.buffer, plain.byteOffset).getUint32(0, true);
		const seed   = plain.slice(4);                        // 32 bytes

		const oldDr = this._decapRoots.get(senderUsername);
		if (oldDr) wipe(oldDr);
		const oldSt = this._senderState.get(senderUsername);
		if (oldSt) {
			oldSt.chain.dispose(); oldSt.store.wipeAll();
		}

		const init = ratchetInit(seed, this._roomCtx);
		this._decapRoots.set(senderUsername, init.nextRootKey);
		this._senderState.set(senderUsername, {
			chain: new KDFChain(init.sendChainKey),
			epoch,
			store: new SkippedKeyStore(),
		});
		wipe(init.sendChainKey);
		wipe(init.recvChainKey);
		wipe(plain);  // wipe full 36 bytes, includes epoch prefix bytes
		wipe(seed);   // wipe the slice allocation too
	}

	updatePeerRatchetEk(peerUsername: string, ek: Uint8Array): void {
		const old = this._peerRatchetEks.get(peerUsername);
		if (old) wipe(old);
		this._peerRatchetEks.set(peerUsername, ek.slice());
	}

	sealMessage(plaintext: Uint8Array): { ciphertext: Uint8Array; counter: number; epoch: number } {
		if (this._disposed) throw new Error('Session has been disposed');
		const { key: msgKey, counter } = this._myChain.stepWithCounter();
		const ciphertext = Seal.encrypt(XChaCha20Cipher, msgKey, plaintext);
		wipe(msgKey);
		return { ciphertext, counter, epoch: this._myEpoch };
	}

	sealFileKey(): { msgKey: Uint8Array; counter: number; epoch: number } {
		if (this._disposed) throw new Error('Session has been disposed');
		const { key: msgKey, counter } = this._myChain.stepWithCounter();
		return { msgKey, counter, epoch: this._myEpoch };
	}

	openMessage(
		senderUsername: string,
		epoch:          number,
		counter:        number,
		ciphertext:     Uint8Array,
	): Uint8Array {
		if (this._disposed) throw new Error('Session has been disposed');
		const h = this._resolveKeyCheckout(senderUsername, epoch, counter);
		try {
			const plain = Seal.decrypt(XChaCha20Cipher, h.key, ciphertext);
			h.commit();
			return plain;
		} catch (e) {
			h.rollback();
			throw e;
		}
	}

	openFileKey(senderUsername: string, epoch: number, counter: number): ResolveHandle {
		if (this._disposed) throw new Error('Session has been disposed');
		return this._resolveKeyCheckout(senderUsername, epoch, counter);
	}

	private _resolveKeyCheckout(sender: string, epoch: number, counter: number): ResolveHandle {
		const state = this._senderState.get(sender);
		if (!state) throw new Error(`unknown sender: ${sender}`);

		if (epoch === state.epoch)
			return state.store.resolve(state.chain, counter);

		if (epoch > state.epoch)
			throw new Error('message is from a future epoch, ratchet step not yet received');

		// epoch < state.epoch, look in old state
		const old = this._oldSenderState.get(sender)?.get(epoch);
		if (!old) {
			if (epoch < state.epoch - EPOCH_KEEP_WINDOW)
				throw new Error('message is too old to decrypt');
			throw new Error('key not found');
		}
		return old.store.resolve(old.chain, counter);
	}

	performRatchetStep(peerUsername: string): {
		kemCt:   Uint8Array
		encSeed: Uint8Array
		pn:      number
	} {
		if (this._disposed) throw new Error('Session has been disposed');
		const rk            = this._encapRoots.get(peerUsername);
		const peerRatchetEk = this._peerRatchetEks.get(peerUsername);
		if (!rk) throw new Error(`no encap root for ${peerUsername}`);
		if (!peerRatchetEk) throw new Error(`no ratchet ek for ${peerUsername}`);

		// generate the shared seed only on the first peer call in a batch
		if (!this._pendingRatchetSeed) {
			this._pendingRatchetSeed = crypto.getRandomValues(new Uint8Array(32));
			this._pendingRatchetPn   = this._myChain.n;
		}

		// per-peer KEM encap; wraps the shared seed
		const result  = kemRatchetEncap(new MlKem768(), rk, peerRatchetEk, this._roomCtx);
		const encSeed = Seal.encrypt(XChaCha20Cipher, result.sendChainKey, this._pendingRatchetSeed);
		wipe(result.sendChainKey);

		wipe(result.recvChainKey);

		wipe(rk);
		this._encapRoots.set(peerUsername, result.nextRootKey);

		return { kemCt: result.kemCt, encSeed, pn: this._pendingRatchetPn };
	}

	commitRatchetStep(): void {
		if (this._disposed) throw new Error('Session has been disposed');
		if (!this._pendingRatchetSeed) throw new Error('no pending ratchet step');

		this._myChain.dispose();
		const initResult = ratchetInit(this._pendingRatchetSeed, this._roomCtx);
		this._myChain    = new KDFChain(initResult.sendChainKey);
		wipe(initResult.sendChainKey);
		wipe(initResult.recvChainKey);
		wipe(initResult.nextRootKey);
		this._myEpoch++;
		this._currentEpochSeed = this._pendingRatchetSeed.slice(); // independent copy
		wipe(this._pendingRatchetSeed);
		this._pendingRatchetSeed = null;
		this._pendingRatchetPn   = 0;
		wipe(this._chainSeed);  // no further use after epoch 0
	}

	receiveRatchetStep(
		sender:  string,
		kemCt:   Uint8Array,
		encSeed: Uint8Array,
		pn:      number,
	): void {
		if (this._disposed) throw new Error('Session has been disposed');
		const rk = this._decapRoots.get(sender);
		if (!rk) throw new Error(`no decap root for ${sender}`);

		const result  = this._kp.decap(new MlKem768(), rk, kemCt, this._roomCtx);
		const newSeed = Seal.decrypt(XChaCha20Cipher, result.recvChainKey, encSeed);
		wipe(result.recvChainKey);

		// retire old epoch
		const oldState = this._senderState.get(sender);
		if (!oldState) throw new Error(`no sender state for ${sender}`);
		oldState.store.advanceToBoundary(oldState.chain, pn);
		let epochMap = this._oldSenderState.get(sender);
		if (!epochMap) {
			epochMap = new Map();
			this._oldSenderState.set(sender, epochMap);
		}
		epochMap.set(oldState.epoch, { chain: oldState.chain, store: oldState.store });

		// prune epochs older than N - EPOCH_KEEP_WINDOW
		const newEpoch = oldState.epoch + 1;
		for (const [ep, { chain, store }] of epochMap) {
			if (ep < newEpoch - EPOCH_KEEP_WINDOW) {
				chain.dispose();
				store.wipeAll();
				epochMap.delete(ep);
			}
		}

		const initResult = ratchetInit(newSeed, this._roomCtx);
		this._senderState.set(sender, {
			chain: new KDFChain(initResult.sendChainKey),
			epoch: oldState.epoch + 1,
			store: new SkippedKeyStore(),
		});
		wipe(initResult.sendChainKey);
		wipe(initResult.recvChainKey);
		wipe(initResult.nextRootKey);
		wipe(newSeed);

		wipe(rk);
		this._decapRoots.set(sender, result.nextRootKey);

		wipe(result.sendChainKey);

		// rotate keypair; dk consumed by decap, new ek must be broadcast via ek_update
		this._kp.dispose();
		this._kp = new RatchetKeypair(new MlKem768());
	}

	removePeer(username: string): void {
		const st = this._senderState.get(username);
		if (st) {
			st.chain.dispose();
			st.store.wipeAll();
			this._senderState.delete(username);
		}
		const old = this._oldSenderState.get(username);
		if (old) {
			for (const { chain, store } of old.values()) {
				chain.dispose();
				store.wipeAll();
			}
			this._oldSenderState.delete(username);
		}
		const er = this._encapRoots.get(username);
		if (er) {
			wipe(er); this._encapRoots.delete(username);
		}
		const dr = this._decapRoots.get(username);
		if (dr) {
			wipe(dr); this._decapRoots.delete(username);
		}
		const ek = this._peerRatchetEks.get(username);
		if (ek) {
			wipe(ek); this._peerRatchetEks.delete(username);
		}
		this._identity.removePeer(username);
	}

	dispose(): void {
		if (this._disposed) return;
		this._disposed = true;

		this._myChain.dispose();
		wipe(this._dk);
		wipe(this._ek);
		wipe(this._chainSeed);
		wipe(this._currentEpochSeed);
		this._kp.dispose();

		if (this._pendingRatchetSeed) {
			wipe(this._pendingRatchetSeed);
			this._pendingRatchetSeed = null;
		}

		for (const rk of this._encapRoots.values()) wipe(rk);
		this._encapRoots.clear();
		for (const rk of this._decapRoots.values()) wipe(rk);
		this._decapRoots.clear();
		for (const ek of this._peerRatchetEks.values()) wipe(ek);
		this._peerRatchetEks.clear();

		for (const { chain, store } of this._senderState.values()) {
			chain.dispose();
			store.wipeAll();
		}
		this._senderState.clear();

		for (const epochMap of this._oldSenderState.values())
			for (const { chain, store } of epochMap.values()) {
				chain.dispose();
				store.wipeAll();
			}
		this._oldSenderState.clear();

		this._identity.dispose();
	}
}
