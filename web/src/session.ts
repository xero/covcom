import {
	Session,
	generateKeypair,
	PROTOCOL,
	PROTOCOL_VERSION,
	SealStream,
	OpenStream,
	XChaCha20Cipher,
	FILE_CHUNK_SIZE,
	forEachChunk,
	WINDOW,
	ACK_INTERVAL,
	RELAY_TAG_SEED,
	RELAY_TAG_FILE_ACK,
	prefixTag,
	readRelayTag,
	encodeFileAck,
	decodeFileAck,
	wipe,
} from '@covcom/lib';
import type { InvitePayload, MessageEnvelope, FingerprintSurface } from '@covcom/lib';
import { Emitter } from './emitter.js';
import { redact, summarizeInbound, summarizeOutbound } from './wireSummary.js';
import type { InboundMsg, OutboundMsg } from './wireTypes.js';
import type { Room } from './store.js';
import type { RichText } from './rich.js';

export interface SessionEvents {
	'phase':                     { phase: 'joining' | 'waiting' | 'ready'; room: Room; username: string };
	'peer-joined':               { username: string; fingerprint: FingerprintSurface };
	'peer-known':                { username: string; fingerprint: FingerprintSurface };
	'peer-left':                 { username: string };
	'local-fingerprint-changed': { fingerprint: FingerprintSurface };
	'message':                   { from: string; text: string; isSelf: boolean; epoch: number; counter: number; ts: number };
	'file':                      { from: string; filename: string; mime: string; size: number; blob: Blob; isSelf: boolean; ts: number };
	'ratchet':                   { from: string; isSelf: boolean; ts: number };
	'wire':                      { direction: 'in' | 'out'; kind: string; summary: RichText; details: Record<string, unknown> };
	'log':                       { kind: string; summary: string; details?: Record<string, unknown> };
	'info':                      { kind: string; text: string; details?: Record<string, unknown> };
	'fatal':                     { reason: string; prefill?: { username?: string } };
	'connection-lost':           { at: number };
	'connection-restored':       { at: number; downMs: number };
}

const RECONNECT_INITIAL_MS  = 1000;
const RECONNECT_MAX_MS      = 30000;

function b64enc(bytes: Uint8Array): string {
	let s = '';
	const CHUNK = 8192;
	for (let i = 0; i < bytes.length; i += CHUNK)
		s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
	return btoa(s);
}

function b64dec(s: string): Uint8Array {
	return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function wsUrl(server: string): string {
	// Scheme follows the page's security context, not the target hostname: an
	// https page must speak wss (mixed-content + CSP both forbid ws), a plain
	// http page speaks ws. This is the single rule that holds for the same-origin
	// container (wss://DOMAIN/ws via Caddy) and plaintext self-host alike.
	const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
	// Tolerate a pasted scheme prefix / trailing slash so `https://host` and
	// `host/` both normalize to the bare authority before we build the ws URL.
	const host = server.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
	return `${scheme}://${host}/ws`;
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// In-flight inbound file transfer, keyed by `${from}|${fileId}`. The OpenStream
// decrypts chunk by chunk; plaintext chunks accumulate until the final frame,
// then assemble into a Blob. `handle` holds the resolved file-key checkout,
// committed on success / rolled back on failure or teardown.
interface InboundFile {
	opener:   OpenStream;
	handle:   { key: Uint8Array; commit: () => void; rollback: () => void };
	chunks:   Uint8Array[];
	nextSeq:  number;
	filename: string;
	mime:     string;
	size:     number;
	ts:       number;
}

function newFileId(): string {
	return crypto.randomUUID();
}

// One long-lived instance per tab (per arch). `dispose()` is for `beforeunload`;
// fatal/teardown paths return _phase to 'idle' so the same instance is reusable.
export class CovcomSession extends Emitter<SessionEvents> {
	private _ws:                WebSocket | null = null;
	private _lib:               Session | null = null;
	private _phase:             'idle' | 'joining' | 'waiting' | 'ready' = 'idle';
	private _room:              Room | null = null;
	private _username           = '';
	private _server             = '';
	private _knownPeers = new Set<string>();
	private _peerRatchetEk = new Map<string, string>();
	private _chainsExpected     = 0;
	private _chainsReceived     = 0;
	private _isReconnect        = false;
	private _settled            = false;
	private _pendingRekey       = false;
	private _connectionLostAt   = 0;
	private _reconnectTimer:    ReturnType<typeof setTimeout> | null = null;
	private _reconnectDelay     = RECONNECT_INITIAL_MS;
	private _inboundFiles       = new Map<string, InboundFile>();
	// Per-transfer sender pacing state, keyed by fileId. `recipients` is snapshot
	// from _knownPeers at file-begin; `acked` tracks each recipient's last acked
	// seq (init -1). The sender holds within WINDOW of the slowest recipient.
	private _sendingFiles       = new Map<string, { recipients: Set<string>; acked: Map<string, number> }>();

	// ── public API ───────────────────────────────────────────────────────────

	async create(opts: { server: string; username: string; adminToken?: string }): Promise<void> {
		this._teardown();
		this._server      = opts.server;
		this._username    = opts.username;
		this._isReconnect = false;
		this._settled     = false;
		this._openWs(opts.server, () => this._sendOut({ type: 'create', adminToken: opts.adminToken, protocolVersion: PROTOCOL_VERSION }));
	}

	async join(invite: InvitePayload, username: string): Promise<void> {
		this._teardown();
		const dns         = invite.dns ?? '127.0.0.1:1337';
		this._server      = dns;
		this._username    = username;
		this._room        = { id: invite.roomId, secret: b64dec(invite.roomSecret), dns };
		this._isReconnect = false;
		this._settled     = false;
		this._emitPhase('joining');
		this._openWs(dns, () => this._sendJoin());
	}

	// Returns false when the message could not be sent so the caller (chat view)
	// can keep the user's text in the textarea.
	sendMessage(text: string): boolean {
		if (this._phase !== 'ready' || !this._lib || !this._isWsOpen()) return false;
		try {
			if (this._lib.counter >= PROTOCOL.autoRatchetEvery && this._knownPeers.size > 0) this._doRatchetStep();
			const bytes = new TextEncoder().encode(text);
			const { ciphertext, counter, epoch } = this._lib.sealMessage(bytes);
			const ts  = Date.now();
			const sig = this._lib.identity.signMessage(counter, epoch, this._username, ts, ciphertext);
			const meta: MessageEnvelope = { type: 'message', sender: this._username, counter, epoch, ts };
			this._sendOut({
				type: 'broadcast',
				payload: b64enc(ciphertext),
				meta: meta as unknown as Record<string, unknown>,
				sig: b64enc(sig),
			});
			this.emit('message', { from: this._username, text, isSelf: true, epoch, counter, ts });
			return true;
		} catch (err) {
			this.emit('info', { kind: 'send-fail', text: `Send failed: ${errMsg(err)}`, details: { err: errMsg(err) } });
			return false;
		}
	}

	// Streams the file as a `file-begin` frame (SealStream preamble + metadata)
	// followed by one signed `file-chunk` broadcast per chunk. The file is read in
	// FILE_CHUNK_SIZE slices and the WS send buffer is drained between frames, so
	// peak memory is O(chunkSize) regardless of file size and no frame approaches
	// the broker's 16 MiB ceiling.
	async sendFile(file: File): Promise<void> {
		if (this._phase !== 'ready' || !this._lib || !this._isWsOpen()) return;
		if (this._lib.counter >= PROTOCOL.autoRatchetEvery && this._knownPeers.size > 0) this._doRatchetStep();
		const lib    = this._lib;
		const ts     = Date.now();
		const fileId = newFileId();
		const mime   = file.type || 'application/octet-stream';
		const { msgKey, counter, epoch } = lib.sealFileKey();
		let stream: SealStream | null = null;
		try {
			stream = new SealStream(XChaCha20Cipher, msgKey, { chunkSize: FILE_CHUNK_SIZE });
			// file-begin authenticates the preamble (the transfer's only frame with
			// no chunk ciphertext of its own).
			const beginSig = lib.identity.signMessage(counter, epoch, this._username, ts, stream.preamble);
			const beginMeta: MessageEnvelope = {
				type: 'file-begin', sender: this._username, counter, epoch, ts,
				fileId, filename: file.name, size: file.size, mime,
				chunkSize: FILE_CHUNK_SIZE, preamble: b64enc(stream.preamble),
			};
			this._sendOut({
				type: 'broadcast',
				payload: b64enc(stream.preamble),
				meta: beginMeta as unknown as Record<string, unknown>,
				sig: b64enc(beginSig),
			});
			// Snapshot recipients now; a peer joining mid-transfer missed file-begin
			// and is not a recipient. Empty set (self/lobby) means no pacing.
			const acked = new Map<string, number>();
			for (const p of this._knownPeers) acked.set(p, -1);
			this._sendingFiles.set(fileId, { recipients: new Set(this._knownPeers), acked });

			const s = stream;
			await forEachChunk(
				async (offset, len) => new Uint8Array(await file.slice(offset, offset + len).arrayBuffer()),
				file.size,
				FILE_CHUNK_SIZE,
				async (chunk, seq, final) => {
					await this._waitForCredit(fileId, seq);
					await this._drainWs();
					if (!this._isWsOpen()) throw new Error('connection lost during file send');
					const ct  = final ? s.finalize(chunk) : s.push(chunk);
					const sig = lib.identity.signMessage(counter, epoch, this._username, ts, ct);
					const meta: MessageEnvelope = {
						type: 'file-chunk', sender: this._username, counter, epoch, ts, fileId, seq, final,
					};
					this._sendOut({
						type: 'broadcast',
						payload: b64enc(ct),
						meta: meta as unknown as Record<string, unknown>,
						sig: b64enc(sig),
					});
				},
			);
			// Self-echo carries the original File (a Blob) so the sender's own card
			// downloads without re-materializing the bytes.
			this.emit('file', { from: this._username, filename: file.name, mime, size: file.size, blob: file, isSelf: true, ts });
		} catch (err) {
			this.emit('info', { kind: 'send-fail', text: `Send failed: ${errMsg(err)}`, details: { err: errMsg(err), filename: file.name } });
		} finally {
			this._sendingFiles.delete(fileId);
			stream?.dispose();
			wipe(msgKey);
		}
	}

	// Hold within WINDOW chunks of the slowest recipient so in-flight frames never
	// overflow the relay's send buffer. Resolves immediately when there is no
	// pacing state (cancelled), no recipients (self/lobby), or enough credit. Bails
	// if the ws closes or the transfer is torn down; the send loop's own
	// _isWsOpen check then aborts the transfer.
	private async _waitForCredit(fileId: string, seq: number): Promise<void> {
		for (;;) {
			const st = this._sendingFiles.get(fileId);
			if (!st || st.recipients.size === 0 || !this._isWsOpen()) return;
			const minAcked = Math.min(...st.acked.values());
			if (seq - minAcked <= WINDOW) return;
			await new Promise((r) => setTimeout(r, 10));
		}
	}

	// Pause the send loop while the WS send buffer is backed up, so streaming a
	// large file can't balloon the socket buffer to O(filesize). No 'drain' event
	// on WebSocket, so poll bufferedAmount.
	private async _drainWs(threshold = 4 * 1024 * 1024): Promise<void> {
		const ws = this._ws;
		if (!ws) return;
		while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount > threshold)
			await new Promise((r) => setTimeout(r, 10));
	}

	rotate(): void {
		if (this._phase !== 'ready') return;
		if (this._knownPeers.size === 0) return;
		this._doRatchetStep();
	}

	dispose(): void {
		this._teardown();
	}

	// ── internals: lifecycle ─────────────────────────────────────────────────

	private _teardown(): void {
		this._disposeAllInbound();
		this._sendingFiles.clear();
		if (this._reconnectTimer !== null) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = null;
		}
		if (this._ws) {
			this._ws.onopen    = null;
			this._ws.onmessage = null;
			this._ws.onclose   = null;   // suppress reconnect on intentional close
			this._ws.onerror   = null;
			try {
				this._ws.close();
			} catch { /* ignore */ }
			this._ws = null;
		}
		this._lib?.dispose();
		this._lib              = null;
		this._phase            = 'idle';
		this._room             = null;
		this._knownPeers.clear();
		this._peerRatchetEk.clear();
		this._chainsExpected   = 0;
		this._chainsReceived   = 0;
		this._connectionLostAt = 0;
		this._reconnectDelay   = RECONNECT_INITIAL_MS;
		this._pendingRekey     = false;
		this._isReconnect      = false;
		this._settled          = false;
	}

	// Setting `_phase` and emitting are paired so callers can't drift them apart.
	// 'joining' is suppressed during reconnect so chat stays mounted.
	private _emitPhase(phase: 'joining' | 'waiting' | 'ready'): void {
		this._phase = phase;
		if (!this._room) return;
		if (phase === 'joining' && this._isReconnect) return;
		this.emit('phase', { phase, room: this._room, username: this._username });
	}

	private _isWsOpen(): boolean {
		return !!this._ws && this._ws.readyState === WebSocket.OPEN;
	}

	private _openWs(server: string, onOpen: () => void): void {
		let ws: WebSocket;
		try {
			ws = new WebSocket(wsUrl(server));
		} catch {
			this._settled = true;
			this.emit('fatal', { reason: 'invalid_server', prefill: { username: this._username } });
			this._teardown();
			return;
		}
		this._ws = ws;
		ws.onopen    = () => onOpen();
		ws.onmessage = (e) => this._onWsMessage(e.data as string);
		ws.onclose   = () => this._onWsClose();
	}

	private _sendJoin(): void {
		if (!this._room) return;
		this._sendOut({
			type: 'join',
			roomId: this._room.id,
			roomSecret: b64enc(this._room.secret),
			protocolVersion: PROTOCOL_VERSION,
		});
	}

	private _sendOut(msg: OutboundMsg): void {
		if (!this._isWsOpen() || !this._ws) return;
		this._ws.send(JSON.stringify(msg));
		const sum = summarizeOutbound(msg);
		this.emit('wire', { direction: 'out', kind: msg.type, summary: sum.summary, details: sum.details });
	}

	private _onWsMessage(data: string): void {
		let msg: InboundMsg;
		try {
			msg = JSON.parse(data) as InboundMsg;
		} catch (err) {
			this.emit('log', { kind: 'parse-error', summary: 'ws message parse failed', details: { err: errMsg(err) } });
			return;
		}
		try {
			this._handleInbound(msg);
		} catch (err) {
			this.emit('info', {
				kind: 'message-fail',
				text: `[dropped a ${msg.type} message that failed processing (${errMsg(err)})]`,
				details: { type: msg.type, err: errMsg(err) },
			});
		}
	}

	private _handleInbound(msg: InboundMsg): void {
		const sum = summarizeInbound(msg);
		this.emit('wire', { direction: 'in', kind: msg.type, summary: sum.summary, details: sum.details });

		switch (msg.type) {
		case 'room_created':
			if (!this._checkServerVersion(msg.serverVersion)) break;
			this._onRoomCreated(msg.roomId, msg.roomSecret);
			break;
		case 'joined':
			if (!this._checkServerVersion(msg.serverVersion)) break;
			this._onJoined(msg.members);
			break;
		case 'peer_joined':
			this._onPeerJoined(msg);
			break;
		case 'peer_left':
			this._onPeerLeft(msg.username);
			break;
		case 'relay':
			this._onRelay(msg.from, msg.payload);
			break;
		case 'broadcast':
			this._onBroadcast(msg.from, msg.payload, msg.meta, msg.sig);
			break;
		case 'ratchet_step_fwd':
			this._onRatchetStepFwd(msg);
			break;
		case 'ek_update_fwd':
			this._onEkUpdateFwd(msg);
			break;
		case 'rekeyed':
			this._onRekeyed();
			break;
		case 'error':
			this._onError(msg.reason);
			break;
		}
	}

	private _onWsClose(): void {
		if (this._settled) return;
		this._ws = null;

		// failure before reaching waiting/ready: fatal back to landing
		if (this._phase === 'idle' || this._phase === 'joining') {
			if (this._isReconnect) {
				// reconnect attempt closed before joined came back; retry
				this._scheduleReconnect();
				return;
			}
			this._settled = true;
			this.emit('fatal', { reason: 'unreachable', prefill: { username: this._username } });
			this._teardown();
			return;
		}

		// mid-session drop: schedule reconnect, keep chat mounted via store. Inbound
		// transfers hold checkouts against _lib's key stores, so drop them first.
		this._connectionLostAt = Date.now();
		this.emit('connection-lost', { at: this._connectionLostAt });
		this._disposeAllInbound();
		this._lib?.dispose();
		this._lib = null;
		this._chainsExpected = 0;
		this._chainsReceived = 0;
		this._peerRatchetEk.clear();
		this._scheduleReconnect();
	}

	// ── internals: connect / reconnect ──────────────────────────────────────

	private _onRoomCreated(roomId: string, roomSecret: string): void {
		this._room = { id: roomId, secret: b64dec(roomSecret), dns: this._server };
		this._emitPhase('joining');
		this._sendJoin();
	}

	private _scheduleReconnect(): void {
		this._reconnectTimer = setTimeout(() => {
			void this._attemptReconnect();
		}, this._reconnectDelay);
	}

	private _attemptReconnect(): void {
		this._reconnectTimer = null;
		if (!this._room) return;
		const dns = this._room.dns ?? this._server;
		this.emit('log', {
			kind: 'reconnect',
			summary: `reconnect attempt (delay=${this._reconnectDelay}ms)`,
			details: { delay: this._reconnectDelay, dns },
		});
		// The WebSocket open is the reachability probe. Grow backoff now; if the
		// socket fails to (re)establish, _onWsClose reschedules with this delay.
		// A successful join resets it (see _onJoined / connection-restored).
		this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_MS);
		this._isReconnect    = true;
		this._settled        = false;
		this._openWs(dns, () => this._sendJoin());
	}

	// ── internals: protocol handlers ────────────────────────────────────────

	private _onJoined(members: { username: string; ek: string; ratchetEk: string; claim: string }[]): void {
		// rebuild the lib session for this attempt (fresh keys each connect)
		this._lib?.dispose();
		const room = this._room;
		if (!room) return;
		try {
			this._lib = new Session(generateKeypair(), room.id);
		} catch (err) {
			this._settled = true;
			this.emit('fatal', { reason: 'wasm_init_fail', prefill: { username: this._username } });
			this.emit('log', { kind: 'wasm-init-fail', summary: 'session init failed', details: { err: errMsg(err) } });
			this._teardown();
			return;
		}
		const lib = this._lib;
		this._chainsExpected = 0;
		this._chainsReceived = 0;
		this._peerRatchetEk.clear();
		this.emit('local-fingerprint-changed', { fingerprint: lib.identity.localFingerprint() });

		// identify ourselves
		const selfClaim = lib.identity.buildClaim(lib.ratchetEk, this._username, room.id, lib.epoch);
		this._sendOut({
			type: 'identify',
			username: this._username,
			ek: b64enc(lib.ek),
			ratchetEk: b64enc(lib.ratchetEk),
			claim: b64enc(selfClaim),
		});

		for (const m of members) {
			try {
				lib.identity.acceptClaim(m.username, b64dec(m.claim));
			} catch (err) {
				this.emit('info', {
					kind: 'claim-reject',
					text: `[${m.username}: identity claim rejected, dropping peer (${errMsg(err)})]`,
					details: { username: m.username, err: errMsg(err), claim: redact(m.claim) },
				});
				continue;
			}
			try {
				const blob = lib.wrapChainSeedFor(b64dec(m.ek), m.username);
				this._sendOut({ type: 'relay', to: m.username, payload: b64enc(prefixTag(RELAY_TAG_SEED, blob)) });
				const fp = lib.identity.peerFingerprint(m.username);
				if (!fp) continue;
				lib.updatePeerRatchetEk(m.username, b64dec(m.ratchetEk));
				this._peerRatchetEk.set(m.username, m.ratchetEk);
				const wasKnown = this._knownPeers.has(m.username);
				this.emit(wasKnown ? 'peer-known' : 'peer-joined', { username: m.username, fingerprint: fp });
				this._knownPeers.add(m.username);
				this._chainsExpected++;
			} catch (err) {
				this.emit('info', {
					kind: 'key-exchange-fail',
					text: `[${m.username}: key exchange failed, dropping peer (${errMsg(err)})]`,
					details: { username: m.username, err: errMsg(err) },
				});
			}
		}

		// empty room: emit phase 'waiting'. With peers, stay internally in
		// 'joining' until chains drain; _onRelay flips to 'ready'.
		if (this._chainsExpected === 0) {
			this._emitPhase('waiting');
		} else {
			this._phase = 'joining';
		}

		if (this._isReconnect && this._connectionLostAt) {
			const at     = Date.now();
			const downMs = at - this._connectionLostAt;
			this.emit('connection-restored', { at, downMs });
			this._connectionLostAt = 0;
			this._reconnectDelay   = RECONNECT_INITIAL_MS;
		}
	}

	private _onPeerJoined(msg: { username: string; ek: string; ratchetEk: string; claim: string }): void {
		if (this._phase !== 'waiting' && this._phase !== 'ready') return;
		const lib = this._lib;
		if (!lib) return;
		try {
			lib.identity.acceptClaim(msg.username, b64dec(msg.claim));
		} catch (err) {
			this.emit('info', {
				kind: 'claim-reject',
				text: `[${msg.username}: identity claim rejected (${errMsg(err)})]`,
				details: { username: msg.username, err: errMsg(err), claim: redact(msg.claim) },
			});
			return;
		}
		try {
			const blob = lib.wrapChainSeedFor(b64dec(msg.ek), msg.username);
			this._sendOut({ type: 'relay', to: msg.username, payload: b64enc(prefixTag(RELAY_TAG_SEED, blob)) });
			lib.updatePeerRatchetEk(msg.username, b64dec(msg.ratchetEk));
			this._peerRatchetEk.set(msg.username, msg.ratchetEk);
			const fp = lib.identity.peerFingerprint(msg.username);
			if (!fp) return;
			const wasKnown = this._knownPeers.has(msg.username);
			this.emit(wasKnown ? 'peer-known' : 'peer-joined', { username: msg.username, fingerprint: fp });
			this._knownPeers.add(msg.username);
			if (this._phase === 'waiting') {
				this._chainsExpected++;
				this._phase = 'joining';
			}
		} catch (err) {
			this.emit('info', {
				kind: 'key-exchange-fail',
				text: `[${msg.username}: key exchange failed (${errMsg(err)})]`,
				details: { username: msg.username, err: errMsg(err) },
			});
		}
	}

	private _onRelay(from: string, payloadB64: string): void {
		const lib = this._lib;
		if (!lib) return;
		const { tag, body } = readRelayTag(b64dec(payloadB64));
		if (tag === RELAY_TAG_FILE_ACK) {
			const { fileId, seq } = decodeFileAck(body);
			const st = this._sendingFiles.get(fileId);
			if (st && st.recipients.has(from) && seq > (st.acked.get(from) ?? -1)) st.acked.set(from, seq);
			return;
		}
		try {
			lib.unwrapChainSeed(from, body);
		} catch (err) {
			this.emit('info', {
				kind: 'key-exchange-fail',
				text: `[${from}: chain seed unwrap failed (${errMsg(err)})]`,
				details: { from, err: errMsg(err) },
			});
			return;
		}
		const storedEk = this._peerRatchetEk.get(from);
		if (storedEk) lib.updatePeerRatchetEk(from, b64dec(storedEk));

		if (this._phase === 'joining') {
			this._chainsReceived++;
			if (this._chainsReceived >= this._chainsExpected && this._chainsExpected > 0) {
				this._emitPhase('ready');
				this._doRatchetStep();
			}
		}
	}

	private _onRatchetStepFwd(msg: {
		from: string; kemCt: string; encSeed: string; pn: number; newEk: string;
		payload: string; meta: Record<string, unknown>; sig: string; claim: string;
	}): void {
		if (this._phase !== 'ready' || !this._lib || !this._room) return;
		const lib = this._lib;
		try {
			lib.identity.acceptClaim(msg.from, b64dec(msg.claim));
		} catch (err) {
			this.emit('info', {
				kind: 'claim-reject',
				text: `[${msg.from}: ratchet claim rejected (${errMsg(err)})]`,
				details: { from: msg.from, err: errMsg(err), claim: redact(msg.claim) },
			});
			return;
		}
		try {
			lib.receiveRatchetStep(msg.from, b64dec(msg.kemCt), b64dec(msg.encSeed), msg.pn);
			lib.updatePeerRatchetEk(msg.from, b64dec(msg.newEk));
			this._peerRatchetEk.set(msg.from, msg.newEk);
		} catch (err) {
			this.emit('info', {
				kind: 'ratchet-fail',
				text: `[${msg.from}: ratchet step failed (${errMsg(err)})]`,
				details: { from: msg.from, err: errMsg(err) },
			});
			return;
		}

		// advertise our new ek to the room
		try {
			const ekClaim = lib.identity.buildClaim(lib.ratchetEk, this._username, this._room.id, lib.epoch);
			this._sendOut({ type: 'ek_update', ek: b64enc(lib.ratchetEk), claim: b64enc(ekClaim) });
		} catch (err) {
			this.emit('log', { kind: 'ek-update-fail', summary: 'ek_update send failed', details: { err: errMsg(err) } });
		}

		// verify + open the sentinel payload to advance the chain; plaintext discarded
		const meta       = msg.meta as unknown as MessageEnvelope;
		const ciphertext = b64dec(msg.payload);
		const sig        = b64dec(msg.sig);
		const verified   = lib.identity.verifyMessage(msg.from, meta.counter, meta.epoch ?? 0, meta.sender, meta.ts, ciphertext, sig);
		if (!verified) {
			this.emit('info', {
				kind: 'verify-fail',
				text: `[${msg.from}: ratchet message signature invalid]`,
				details: { from: msg.from },
			});
		} else {
			try {
				lib.openMessage(msg.from, meta.epoch ?? 0, meta.counter, ciphertext);
			} catch (err) {
				this.emit('info', {
					kind: 'decrypt-fail',
					text: `[${msg.from}: ratchet decrypt failed (${errMsg(err)})]`,
					details: { from: msg.from, err: errMsg(err) },
				});
			}
		}
		this.emit('ratchet', { from: msg.from, isSelf: false, ts: Date.now() });
	}

	private _onEkUpdateFwd(msg: { from: string; ek: string; claim: string }): void {
		if (this._phase !== 'ready' && this._phase !== 'waiting') return;
		const lib = this._lib;
		if (!lib) return;
		try {
			lib.identity.acceptClaim(msg.from, b64dec(msg.claim));
		} catch (err) {
			this.emit('info', {
				kind: 'claim-reject',
				text: `[${msg.from}: ek_update claim rejected (${errMsg(err)})]`,
				details: { from: msg.from, err: errMsg(err), claim: redact(msg.claim) },
			});
			return;
		}
		lib.updatePeerRatchetEk(msg.from, b64dec(msg.ek));
		this._peerRatchetEk.set(msg.from, msg.ek);
	}

	private _onBroadcast(
		from:    string,
		payload: string,
		meta:    Record<string, unknown>,
		sigB64:  string,
	): void {
		if (this._phase !== 'ready' || !this._lib) return;
		const lib        = this._lib;
		const envelope   = meta as unknown as MessageEnvelope;
		const ciphertext = b64dec(payload);
		const sig        = b64dec(sigB64);
		const verified   = lib.identity.verifyMessage(
			from, envelope.counter, envelope.epoch ?? 0, envelope.sender, envelope.ts, ciphertext, sig,
		);
		if (!verified) {
			this.emit('info', {
				kind: 'verify-fail',
				text: `[${from}: message signature invalid]`,
				details: { from },
			});
			return;
		}
		if (envelope.type === 'message') {
			let plain: Uint8Array;
			try {
				plain = lib.openMessage(from, envelope.epoch ?? 0, envelope.counter, ciphertext);
			} catch (err) {
				this.emit('info', {
					kind: 'decrypt-fail',
					text: `[${from}: ${errMsg(err)}]`,
					details: { from, err: errMsg(err) },
				});
				return;
			}
			const text = new TextDecoder().decode(plain);
			this.emit('message', {
				from, text, isSelf: false,
				epoch: envelope.epoch ?? 0, counter: envelope.counter, ts: envelope.ts,
			});
			return;
		}
		if (envelope.type === 'file-begin') {
			this._onFileBegin(from, envelope, ciphertext); return;
		}
		if (envelope.type === 'file-chunk') {
			this._onFileChunk(from, envelope, ciphertext);
		}
	}

	private _onFileBegin(from: string, env: MessageEnvelope, preamble: Uint8Array): void {
		const lib = this._lib;
		if (!lib) return;
		const key = `${from}|${env.fileId}`;
		this._disposeInbound(key);   // drop any stale transfer reusing this id
		let handle: { key: Uint8Array; commit: () => void; rollback: () => void };
		try {
			handle = lib.openFileKey(from, env.epoch ?? 0, env.counter);
		} catch (err) {
			this.emit('info', { kind: 'decrypt-fail', text: `[${from}: file key resolve failed (${errMsg(err)})]`, details: { from, err: errMsg(err) } });
			return;
		}
		let opener: OpenStream;
		try {
			opener = new OpenStream(XChaCha20Cipher, handle.key, preamble);
		} catch (err) {
			handle.rollback();
			this.emit('info', { kind: 'decrypt-fail', text: `[${from}: file open failed (${errMsg(err)})]`, details: { from, err: errMsg(err), filename: env.filename ?? '∅' } });
			return;
		}
		this._inboundFiles.set(key, {
			opener, handle, chunks: [], nextSeq: 0,
			filename: env.filename ?? 'file',
			mime: env.mime ?? 'application/octet-stream',
			size: env.size ?? 0, ts: env.ts,
		});
	}

	private _onFileChunk(from: string, env: MessageEnvelope, ct: Uint8Array): void {
		const key = `${from}|${env.fileId}`;
		const f   = this._inboundFiles.get(key);
		if (!f) {
			this.emit('info', { kind: 'decrypt-fail', text: `[${from}: file chunk before begin, dropping]`, details: { from, fileId: env.fileId } });
			return;
		}
		if ((env.seq ?? -1) !== f.nextSeq) {
			this._disposeInbound(key);
			this.emit('info', { kind: 'decrypt-fail', text: `[${from}: out-of-order file chunk, dropping transfer]`, details: { from, expected: f.nextSeq, got: env.seq } });
			return;
		}
		let plain: Uint8Array;
		try {
			plain = env.final ? f.opener.finalize(ct) : f.opener.pull(ct);
		} catch (err) {
			f.handle.rollback();
			this._inboundFiles.delete(key);
			this.emit('info', { kind: 'decrypt-fail', text: `[${from}: file decrypt failed (${errMsg(err)})]`, details: { from, err: errMsg(err), filename: f.filename } });
			return;
		}
		f.chunks.push(plain);
		f.nextSeq++;
		// Ack consumed seq so the sender can advance its window. Twice per window
		// plus the terminator; the sender paces to the slowest recipient's ack.
		const seq = env.seq ?? 0;
		if (seq % ACK_INTERVAL === 0 || env.final)
			this._sendOut({ type: 'relay', to: from, payload: b64enc(encodeFileAck(env.fileId ?? '', seq)) });
		if (env.final) {
			f.handle.commit();
			this._inboundFiles.delete(key);
			const blob = new Blob(f.chunks as BlobPart[], { type: f.mime });
			this.emit('file', { from, filename: f.filename, mime: f.mime, size: f.size || blob.size, blob, isSelf: false, ts: f.ts });
		}
	}

	private _disposeInbound(key: string): void {
		const f = this._inboundFiles.get(key);
		if (!f) return;
		try {
			f.opener.dispose();
		} catch { /* already wiped */ }
		try {
			f.handle.rollback();
		} catch { /* already settled */ }
		this._inboundFiles.delete(key);
	}

	private _disposeAllInbound(): void {
		for (const key of [...this._inboundFiles.keys()]) this._disposeInbound(key);
	}

	private _onPeerLeft(username: string): void {
		if (this._phase !== 'ready' && this._phase !== 'waiting') return;
		for (const key of [...this._inboundFiles.keys()])
			if (key.startsWith(`${username}|`)) this._disposeInbound(key);
		// Drop the departed peer from every active send; a pending _waitForCredit
		// re-derives minAcked next poll (empty recipient set => unpaced).
		for (const st of this._sendingFiles.values()) {
			st.recipients.delete(username);
			st.acked.delete(username);
		}
		this._lib?.removePeer(username);
		this._knownPeers.delete(username);
		this._peerRatchetEk.delete(username);
		this.emit('peer-left', { username });
		if (this._phase === 'ready' && this._knownPeers.size === 0) {
			this._doLobbyTransition();
		}
	}

	private _onRekeyed(): void {
		if (!this._pendingRekey) return;
		this._pendingRekey = false;
		this._emitPhase('waiting');
	}

	// True if the server's advertised version matches. A missing field means an
	// older server that predates negotiation (the friend's v2 case): it can't
	// reject us, so the newer client detects the skew and bails. Numbers go to
	// the console for debugging; the on-screen message stays generic.
	private _checkServerVersion(got: number | undefined): boolean {
		if (got === PROTOCOL_VERSION) return true;
		console.warn(`covcom: server protocol version mismatch (expected ${PROTOCOL_VERSION}, got ${got ?? 'none'})`);
		this._onError('version_mismatch');
		return false;
	}

	private _onError(reason: string): void {
		// Server rejected this connection. Same path as fatal: bridge will RESET +
		// GOTO_LANDING with a friendly string mapped from `reason`.
		this._settled = true;
		this.emit('fatal', { reason, prefill: { username: this._username } });
		this._teardown();
	}

	// ── internals: ratchet / lobby ──────────────────────────────────────────

	private _doRatchetStep(): void {
		if (this._phase !== 'ready' || !this._lib || !this._room) return;
		if (this._knownPeers.size === 0) return;
		const lib = this._lib;
		try {
			const payloads: Record<string, { kemCt: string; encSeed: string; pn: number }> = {};
			for (const peer of this._knownPeers) {
				const { kemCt, encSeed, pn } = lib.performRatchetStep(peer);
				payloads[peer] = { kemCt: b64enc(kemCt), encSeed: b64enc(encSeed), pn };
			}
			lib.commitRatchetStep();

			// sentinel payload, kept on the wire so receivers can verify the new
			// chain works; never surfaced as a `message` event (arch decision)
			const bytes                            = new TextEncoder().encode('[\u{1F512} keys rotated]');
			const { ciphertext, counter, epoch }   = lib.sealMessage(bytes);
			const ts                               = Date.now();
			const sig                              = lib.identity.signMessage(counter, epoch, this._username, ts, ciphertext);
			const claim                            = lib.identity.buildClaim(lib.ratchetEk, this._username, this._room.id, epoch);
			const meta: MessageEnvelope            = { type: 'message', sender: this._username, counter, epoch, ts };
			this._sendOut({
				type: 'ratchet_step',
				payloads,
				newEk: b64enc(lib.ratchetEk),
				payload: b64enc(ciphertext),
				meta: meta as unknown as Record<string, unknown>,
				sig: b64enc(sig),
				claim: b64enc(claim),
			});
			this.emit('ratchet', { from: this._username, isSelf: true, ts });
		} catch (err) {
			this.emit('info', {
				kind: 'rotate-fail',
				text: `[key rotation failed (${errMsg(err)})]`,
				details: { err: errMsg(err) },
			});
		}
	}

	private _doLobbyTransition(): void {
		if (this._phase !== 'ready' || !this._room) return;
		this._lib?.dispose();
		try {
			this._lib = new Session(generateKeypair(), this._room.id);
		} catch (err) {
			this.emit('info', {
				kind: 'rotate-fail',
				text: `[lobby key rotation failed (${errMsg(err)})]`,
				details: { err: errMsg(err) },
			});
			return;
		}
		const lib            = this._lib;
		this._chainsExpected = 0;
		this._chainsReceived = 0;
		this._peerRatchetEk.clear();
		this._pendingRekey   = true;
		try {
			const claim = lib.identity.buildClaim(lib.ratchetEk, this._username, this._room.id, lib.epoch);
			this._sendOut({
				type: 'rekey',
				ek: b64enc(lib.ek),
				ratchetEk: b64enc(lib.ratchetEk),
				claim: b64enc(claim),
			});
			this.emit('local-fingerprint-changed', { fingerprint: lib.identity.localFingerprint() });
		} catch (err) {
			this._pendingRekey = false;
			this.emit('info', {
				kind: 'rotate-fail',
				text: `[lobby key rotation failed (${errMsg(err)})]`,
				details: { err: errMsg(err) },
			});
		}
	}
}
