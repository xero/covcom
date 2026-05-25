import {
	Sign, Ed25519PreHashSuite,
	BLAKE3, Sha256Tree, MemoryStorage,
	wipe,
} from 'leviathan-crypto';

const CTX_CLAIM       = new TextEncoder().encode('covcom-identity-claim-v3');
const CTX_MESSAGE_SIG = new TextEncoder().encode('covcom-message-sig-v3');

const ZERO_LOG_ROOT = new Uint8Array(32);
const SESSION_ID_LEN = 16;

export interface ClaimPayload {
	sessionPk:    Uint8Array
	senderKeyPub: Uint8Array
	username:     string
	sessionId:    Uint8Array
	epoch:        number
	sequenceNum:  number
	issuedAt:     bigint
	prevLogRoot:  Uint8Array
}

export interface FingerprintSurface {
	swatches: string[]   // 8 hex colors
	hex:      string     // 16 lowercase hex chars
	badge:    string     // 1 hex color
}

function deriveSessionId(roomId: string): Uint8Array {
	const out  = new Uint8Array(SESSION_ID_LEN);
	const utf8 = new TextEncoder().encode(roomId);
	out.set(utf8.subarray(0, Math.min(utf8.length, SESSION_ID_LEN)));
	return out;
}

function encodeClaimPayload(c: ClaimPayload): Uint8Array {
	if (c.sessionPk.length     !== 32) throw new Error('claim: sessionPk must be 32 bytes');
	if (c.sessionId.length     !== SESSION_ID_LEN) throw new Error('claim: sessionId must be 16 bytes');
	if (c.prevLogRoot.length   !== 32) throw new Error('claim: prevLogRoot must be 32 bytes');
	if (c.senderKeyPub.length  > 0xffff) throw new Error('claim: senderKeyPub exceeds 65535 bytes');

	const utf8 = new TextEncoder().encode(c.username);
	if (utf8.length === 0)   throw new Error('claim: username must be non-empty');
	if (utf8.length > 255)   throw new Error('claim: username UTF-8 length exceeds 255');

	const total = 32 + 2 + c.senderKeyPub.length + 1 + utf8.length + SESSION_ID_LEN + 4 + 4 + 8 + 32;
	const buf   = new Uint8Array(total);
	const view  = new DataView(buf.buffer);
	let o = 0;

	buf.set(c.sessionPk, o); o += 32;
	view.setUint16(o, c.senderKeyPub.length, false); o += 2;
	buf.set(c.senderKeyPub, o); o += c.senderKeyPub.length;
	view.setUint8(o, utf8.length); o += 1;
	buf.set(utf8, o); o += utf8.length;
	buf.set(c.sessionId, o); o += SESSION_ID_LEN;
	view.setUint32(o, c.epoch,       false); o += 4;
	view.setUint32(o, c.sequenceNum, false); o += 4;
	view.setBigUint64(o, c.issuedAt, false); o += 8;
	buf.set(c.prevLogRoot, o);

	return buf;
}

function decodeClaimPayload(bytes: Uint8Array): ClaimPayload {
	const min = 32 + 2 + 0 + 1 + 1 + SESSION_ID_LEN + 4 + 4 + 8 + 32;
	if (bytes.length < min) throw new Error('claim: payload too short');

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let o = 0;

	const sessionPk     = bytes.slice(o, o + 32); o += 32;
	const senderKeyLen  = view.getUint16(o, false); o += 2;
	if (o + senderKeyLen > bytes.length) throw new Error('claim: senderKeyPub overflows payload');
	const senderKeyPub  = bytes.slice(o, o + senderKeyLen); o += senderKeyLen;

	const usernameLen = view.getUint8(o); o += 1;
	if (usernameLen === 0)                throw new Error('claim: empty username');
	if (o + usernameLen > bytes.length)   throw new Error('claim: username overflows payload');
	const username = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(o, o + usernameLen));
	o += usernameLen;

	if (o + SESSION_ID_LEN + 4 + 4 + 8 + 32 !== bytes.length)
		throw new Error('claim: trailing bytes or wrong tail length');

	const sessionId   = bytes.slice(o, o + SESSION_ID_LEN); o += SESSION_ID_LEN;
	const epoch       = view.getUint32(o, false); o += 4;
	const sequenceNum = view.getUint32(o, false); o += 4;
	const issuedAt    = view.getBigUint64(o, false); o += 8;
	const prevLogRoot = bytes.slice(o, o + 32);

	return { sessionPk, senderKeyPub, username, sessionId, epoch, sequenceNum, issuedAt, prevLogRoot };
}

function encodeMessageSigInput(
	counter:    number,
	epoch:      number,
	sender:     string,
	ts:         number,
	ciphertext: Uint8Array,
): Uint8Array {
	const senderUtf8 = new TextEncoder().encode(sender);
	if (senderUtf8.length === 0) throw new Error('sig: sender must be non-empty');
	if (senderUtf8.length > 255) throw new Error('sig: sender UTF-8 length exceeds 255');

	const total = 4 + 4 + 1 + senderUtf8.length + 8 + ciphertext.length;
	const buf   = new Uint8Array(total);
	const view  = new DataView(buf.buffer);
	let o = 0;

	view.setUint32(o, counter, false); o += 4;
	view.setUint32(o, epoch,   false); o += 4;
	view.setUint8(o, senderUtf8.length); o += 1;
	buf.set(senderUtf8, o); o += senderUtf8.length;
	view.setBigUint64(o, BigInt(ts), false); o += 8;
	buf.set(ciphertext, o);

	return buf;
}

// 16-bit chunk → OKLCh → sRGB hex. Top 8 bits drive hue (0..360°),
// bottom 8 bits drive lightness (0.30..0.85). Fixed chroma keeps the
// palette in-gamut for most hues; the sRGB clamp handles the few that
// drift out.
function chunkToOklchHex(chunk: number): string {
	const hueBits   = (chunk >> 8) & 0xff;
	const lightBits = chunk & 0xff;

	const h = (hueBits / 256) * 2 * Math.PI;
	const L = 0.30 + (lightBits / 255) * 0.55;
	const C = 0.15;

	const a = C * Math.cos(h);
	const b = C * Math.sin(h);

	const L_ = L + 0.3963377774 * a + 0.2158037573 * b;
	const M_ = L - 0.1055613458 * a - 0.0638541728 * b;
	const S_ = L - 0.0894841775 * a - 1.2914855480 * b;

	const l3 = L_ * L_ * L_;
	const m3 = M_ * M_ * M_;
	const s3 = S_ * S_ * S_;

	let r  =  4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
	let g  = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
	let bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3;

	const toGamma = (x: number): number => {
		if (x <= 0) return 0;
		if (x >= 1) return 1;
		if (x <= 0.0031308) return 12.92 * x;
		return 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
	};

	r  = toGamma(r);
	g  = toGamma(g);
	bl = toGamma(bl);

	const r8 = Math.round(r  * 255);
	const g8 = Math.round(g  * 255);
	const b8 = Math.round(bl * 255);

	return '#' + [r8, g8, b8].map(v => v.toString(16).padStart(2, '0')).join('');
}

function fingerprintFromPk(pk: Uint8Array): FingerprintSurface {
	const bytes = new BLAKE3().hash(pk, 16);
	const view  = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	const swatches: string[] = [];
	for (let i = 0; i < 8; i++) {
		const chunk = view.getUint16(i * 2, false);
		swatches.push(chunkToOklchHex(chunk));
	}

	let hex = '';
	for (let i = 0; i < 8; i++) hex += (bytes[i] ?? 0).toString(16).padStart(2, '0');

	const badge = swatches[0] ?? '#000000';
	return { swatches, hex, badge };
}

interface PeerState {
	sessionPk:        Uint8Array
	lastSeq:          number
	lastPayloadHash:  Uint8Array
	tree:             Sha256Tree
}

export class SessionIdentity {
	private _sessionPk:        Uint8Array;
	private _sessionSk:        Uint8Array;
	private _localSeq:         number;
	private _localLastHash:    Uint8Array;
	private _peers:            Map<string, PeerState>;
	private _disposed:         boolean;

	private constructor(pk: Uint8Array, sk: Uint8Array) {
		this._sessionPk     = pk;
		this._sessionSk     = sk;
		this._localSeq      = 0;
		this._localLastHash = ZERO_LOG_ROOT.slice();
		this._peers         = new Map();
		this._disposed      = false;
	}

	static create(): SessionIdentity {
		const { pk, sk } = Ed25519PreHashSuite.keygen();
		return new SessionIdentity(pk, sk);
	}

	get sessionPk(): Uint8Array {
		return this._sessionPk;
	}

	get disposed(): boolean {
		return this._disposed;
	}

	buildClaim(
		senderKeyPub: Uint8Array,
		username:     string,
		roomId:       string,
		epoch:        number,
	): Uint8Array {
		if (this._disposed) throw new Error('SessionIdentity has been disposed');

		const payload: ClaimPayload = {
			sessionPk: this._sessionPk,
			senderKeyPub,
			username,
			sessionId: deriveSessionId(roomId),
			epoch,
			sequenceNum: this._localSeq,
			issuedAt: BigInt(Date.now()),
			prevLogRoot: this._localLastHash,
		};

		const bytes = encodeClaimPayload(payload);
		const blob  = Sign.sign(Ed25519PreHashSuite, this._sessionSk, bytes, CTX_CLAIM);

		const newHash = new BLAKE3().hash(bytes, 32);
		wipe(this._localLastHash);
		this._localLastHash = newHash;
		this._localSeq++;

		return blob;
	}

	// Verify a claim signed by some peer, check chain continuity, and update
	// the per-peer state. The very first call for a given peer establishes
	// their sessionPk from the payload (self-attesting); subsequent calls
	// require the payload's sessionPk to match the peer's recorded value.
	acceptClaim(senderUsername: string, blob: Uint8Array): ClaimPayload {
		if (this._disposed) throw new Error('SessionIdentity has been disposed');

		const existing = this._peers.get(senderUsername);

		// Peek first to extract the candidate pk; verify against either the
		// stored peer pk (subsequent) or the peeked pk (first contact).
		const peeked   = Sign.peek(blob, Ed25519PreHashSuite);
		const peekedPk = bytesEqual(peeked.ctx, CTX_CLAIM)
			? extractPkFromPeekedPayload(blob, peeked.payloadOffset, peeked.payloadLength)
			: null;
		if (!peekedPk) throw new Error('claim: ctx mismatch or malformed payload');

		const pk = existing ? existing.sessionPk : peekedPk;
		const payloadBytes = Sign.verify(Ed25519PreHashSuite, pk, blob, CTX_CLAIM);
		const payload      = decodeClaimPayload(payloadBytes);

		if (payload.username !== senderUsername)
			throw new Error('claim: username mismatch');
		if (!bytesEqual(payload.sessionPk, pk))
			throw new Error('claim: sessionPk mismatch');

		const payloadHash = new BLAKE3().hash(payloadBytes, 32);

		if (!existing) {
			// Trust-on-first-sight. A late joiner cannot have witnessed this
			// peer's earlier claims, so it anchors on whatever claim it first
			// sees, at whatever sequence number, and verifies forward
			// continuity from that baseline. Requiring sequenceNum 0 here
			// would reject every peer that has already ratcheted, which is the
			// normal state of any established room.
			const tree = new Sha256Tree(new MemoryStorage());
			tree.append(payloadBytes);
			this._peers.set(senderUsername, {
				sessionPk: pk.slice(),
				lastSeq: payload.sequenceNum,
				lastPayloadHash: payloadHash,
				tree,
			});
		} else {
			if (payload.sequenceNum !== existing.lastSeq + 1)
				throw new Error(`claim: sequenceNum gap (expected ${existing.lastSeq + 1}, got ${payload.sequenceNum})`);
			if (!bytesEqual(payload.prevLogRoot, existing.lastPayloadHash))
				throw new Error('claim: prevLogRoot does not match prior payload hash');

			existing.tree.append(payloadBytes);
			wipe(existing.lastPayloadHash);
			existing.lastPayloadHash = payloadHash;
			existing.lastSeq         = payload.sequenceNum;
		}

		return payload;
	}

	signMessage(
		counter:    number,
		epoch:      number,
		sender:     string,
		ts:         number,
		ciphertext: Uint8Array,
	): Uint8Array {
		if (this._disposed) throw new Error('SessionIdentity has been disposed');
		const msg = encodeMessageSigInput(counter, epoch, sender, ts, ciphertext);
		return Sign.signDetached(Ed25519PreHashSuite, this._sessionSk, msg, CTX_MESSAGE_SIG);
	}

	verifyMessage(
		senderUsername: string,
		counter:        number,
		epoch:          number,
		sender:         string,
		ts:             number,
		ciphertext:     Uint8Array,
		sig:            Uint8Array,
	): boolean {
		if (this._disposed) throw new Error('SessionIdentity has been disposed');
		const peer = this._peers.get(senderUsername);
		if (!peer) throw new Error(`no identity claim seen for ${senderUsername}`);
		const msg  = encodeMessageSigInput(counter, epoch, sender, ts, ciphertext);
		return Sign.verifyDetached(Ed25519PreHashSuite, peer.sessionPk, msg, sig, CTX_MESSAGE_SIG);
	}

	hasPeer(senderUsername: string): boolean {
		return this._peers.has(senderUsername);
	}

	removePeer(senderUsername: string): void {
		const peer = this._peers.get(senderUsername);
		if (!peer) return;
		wipe(peer.sessionPk);
		wipe(peer.lastPayloadHash);
		this._peers.delete(senderUsername);
	}

	localFingerprint(): FingerprintSurface {
		return fingerprintFromPk(this._sessionPk);
	}

	peerFingerprint(senderUsername: string): FingerprintSurface | null {
		const peer = this._peers.get(senderUsername);
		if (!peer) return null;
		return fingerprintFromPk(peer.sessionPk);
	}

	dispose(): void {
		if (this._disposed) return;
		this._disposed = true;
		wipe(this._sessionSk);
		wipe(this._localLastHash);
		for (const peer of this._peers.values()) {
			wipe(peer.sessionPk);
			wipe(peer.lastPayloadHash);
		}
		this._peers.clear();
	}
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	return diff === 0;
}

function extractPkFromPeekedPayload(
	blob:          Uint8Array,
	payloadOffset: number,
	payloadLength: number,
): Uint8Array | null {
	if (payloadLength < 32) return null;
	return blob.slice(payloadOffset, payloadOffset + 32);
}
