import { join, basename } from 'path';
import {
	generateKeypair,
	Session,
	serializeInvite,
	armorInvite,
	INVITE_VERSION,
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
import type {
	InvitePayload,
	MessageEnvelope,
	FingerprintSurface,
} from '@covcom/lib';
import { WS } from './ws.js';
import type { InboundMsg, OutboundMsg } from './ws.js';
import { b64enc, b64dec, wsUrl, resolveUniqueFilename } from './util.js';
import { readConfig, writeConfig } from './config.js';
import { registerCleanup } from './lifecycle.js';
import { renderLanding } from './tui/landing.js';
import { renderWaiting } from './tui/waiting.js';
import { renderJoin } from './tui/join.js';
import {
	renderChat,
	appendMessage,
	appendFile,
	showModal,
} from './tui/chat.js';
import { logEvent, resetEvents } from './eventLog.js';
import { summarizeInbound, summarizeOutbound, redact } from './wireSummary.js';

type Screen = Parameters<typeof renderLanding>[0];

interface PeerInfo {
  ek: string;
  ratchetEk: string;
  colorIdx: number;
  fingerprint: FingerprintSurface;
}

type AppState =
  | { phase: 'landing' }
  | {
      phase: 'joining';
      roomId: string;
      roomSecret: string;
      dns: string;
      username: string;
    }
  | {
      phase: 'waiting';
      roomId: string;
      roomSecret: string;
      dns: string;
      session: Session;
      ws: WS;
      username: string;
      peers: Map<string, PeerInfo>;
    }
  | {
      phase: 'ready';
      roomId: string;
      roomSecret: string;
      dns: string;
      session: Session;
      ws: WS;
      username: string;
      peers: Map<string, PeerInfo>;
    };

let current: AppState = { phase: 'landing' };
let _screen: Screen;
let _showSystem = true;
let _keysIcon = '';
let _connectionLostAt = 0;
// Set once we begin tearing down on exit. Suppresses the reconnect path that
// an intentional ws.close() would otherwise trigger during shutdown.
let _shuttingDown = false;

// In-chat ratchet notice. The key icon and this label are colored independently
// (theme.keyFg / theme.ratchetTxtFg) by the ScrollView, so they're passed to
// appendMessage as separate parts rather than a single prebuilt string.
const RATCHET_LABEL = 'keys rotated';

// In-flight inbound file transfer, keyed by `${from}|${fileId}`. Chunks decrypt
// incrementally via OpenStream and accumulate until the final frame; the file is
// written to disk only when the user clicks Download (preserving the CLI's opt-in
// save). `handle` is the resolved file-key checkout, committed on success.
interface InboundFile {
	opener:    OpenStream;
	handle:    { key: Uint8Array; commit: () => void; rollback: () => void };
	chunks:    Uint8Array[];
	nextSeq:   number;
	filename:  string;
	mime:      string;
	size:      number;
	senderIdx: number;
}
const inboundFiles = new Map<string, InboundFile>();

function disposeInbound(key: string): void {
	const f = inboundFiles.get(key);
	if (!f) return;
	try {
		f.opener.dispose();
	} catch { /* already wiped */ }
	try {
		f.handle.rollback();
	} catch { /* already settled */ }
	inboundFiles.delete(key);
}

function disposeAllInbound(): void {
	for (const k of [...inboundFiles.keys()]) disposeInbound(k);
	// Every all-dispose path (exit, disconnect, lobby, fatal) tears the ws down,
	// so any in-flight outbound send is dead too; drop its pacing state.
	sendingFiles.clear();
}

function disposeInboundForPeer(username: string): void {
	for (const k of [...inboundFiles.keys()]) if (k.startsWith(`${username}|`)) disposeInbound(k);
	removePeerFromSends(username);
}

// Per-transfer sender pacing state, keyed by fileId. `recipients` is snapshot
// from the peer set at file-begin; `acked` tracks each recipient's last acked
// seq (init -1). The sender holds within WINDOW of the slowest recipient so
// in-flight frames never overflow the relay's send buffer. See
// lib/src/filetransfer.ts for the credit/ack rationale.
const sendingFiles = new Map<string, { recipients: Set<string>; acked: Map<string, number> }>();

function removePeerFromSends(username: string): void {
	for (const st of sendingFiles.values()) {
		st.recipients.delete(username);
		st.acked.delete(username);
	}
}

// Hold within WINDOW chunks of the slowest recipient. Resolves immediately when
// there is no pacing state (cancelled), no recipients (self/lobby), or enough
// credit; bails if the ws is closed so doSendFile's own guard can abort.
async function waitForCredit(fileId: string, seq: number, ws: WS): Promise<void> {
	for (;;) {
		const st = sendingFiles.get(fileId);
		if (!st || st.recipients.size === 0 || !ws.isOpen()) return;
		const minAcked = Math.min(...st.acked.values());
		if (seq - minAcked <= WINDOW) return;
		await new Promise((r) => setTimeout(r, 10));
	}
}

function attachWireTaps(ws: WS): void {
	ws.onWireOut = (msg: OutboundMsg) => {
		const { summary, details } = summarizeOutbound(msg);
		logEvent({ direction: 'out', kind: msg.type, summary, details });
	};
	ws.onWireIn = (msg: InboundMsg) => {
		const { summary, details } = summarizeInbound(msg);
		logEvent({ direction: 'in', kind: msg.type, summary, details });
	};
}

function makeArmoredInvite(
	roomId: string,
	roomSecret: string,
	dns?: string,
): string {
	return armorInvite(
		serializeInvite({ version: INVITE_VERSION, roomId, roomSecret, dns }),
	);
}

function httpUrl(server: string): string {
	const host = server.split(':')[0];
	const local = host === 'localhost' || host.startsWith('127.');
	return `${local ? 'http' : 'https'}://${server}`;
}

function peerFingerprints(
	peers: Map<string, PeerInfo>,
): { username: string; fingerprint: FingerprintSurface; colorIdx: number }[] {
	const out: { username: string; fingerprint: FingerprintSurface; colorIdx: number }[] = [];
	for (const [username, info] of peers)
		out.push({ username, fingerprint: info.fingerprint, colorIdx: info.colorIdx });
	return out;
}

export function mount(
	screen: Screen,
	config: {
    server?: string;
    username?: string;
    showSystem?: boolean;
    icons?: { keys?: string };
  },
	joinArg?: string,
): void {
	_screen = screen;
	_showSystem = config.showSystem !== false;
	_keysIcon = (config.icons?.keys ?? '').trim();

	// Single teardown for every exit path (Ctrl+C, /exit, SIGTERM, fatal). Reads
	// the module-level `current` so it covers whatever phase we're in, then
	// restores the terminal (leaves alt-screen, re-shows cursor, raw mode off).
	registerCleanup(() => {
		_shuttingDown = true;
		disposeAllInbound();
		if (current.phase === 'waiting' || current.phase === 'ready') {
			current.session.dispose();
			current.ws.close();
		}
		_screen.destroy();
	});
	if (joinArg && config.username) {
		const { username } = config;
		renderJoin(_screen, {
			prefillPath: joinArg,
			username: username,
			onConnect: (invite) => doJoin(invite, username),
		});
	} else {
		renderLanding(_screen, {
			config,
			onCreate: doCreate,
			onJoinClick: (username) => {
				renderJoin(_screen, {
					prefillPath: joinArg,
					username,
					onConnect: (invite) => doJoin(invite, username),
				});
			},
		});
	}
}

function doCreate(server: string, username: string, adminToken?: string): void {
	resetEvents();
	const ws = new WS(wsUrl(server));
	attachWireTaps(ws);
	const dns = server;
	let roomId = '';
	let roomSecret = '';

	logEvent({
		direction: 'local',
		kind: 'phase',
		summary: `creating room on ${server} as ${username}`,
		details: { server, username },
	});

	ws.onOpen = () => {
		// Persist only server + username; read-merge so theme, icons, sidebar, and
		// showSystem on disk survive (a bare write here clobbered them).
		writeConfig({ ...readConfig(), server: dns, username });
		ws.send({ type: 'create', adminToken, protocolVersion: PROTOCOL_VERSION });
	};

	ws.onMessage = (msg) => {
		if (msg.type === 'room_created') {
			if (msg.serverVersion !== PROTOCOL_VERSION) {
				handleVersionMismatch(ws, msg.serverVersion); return;
			}
			roomId = msg.roomId;
			roomSecret = msg.roomSecret;
			current = { phase: 'joining', roomId, roomSecret, dns, username };
			ws.send({ type: 'join', roomId, roomSecret, protocolVersion: PROTOCOL_VERSION });
		} else if (msg.type === 'joined') {
			if (msg.serverVersion !== PROTOCOL_VERSION) {
				handleVersionMismatch(ws, msg.serverVersion); return;
			}
			doConnect(ws, roomId, roomSecret, dns, username, msg.members);
		} else if (msg.type === 'error') {
			if (msg.reason === 'version_mismatch') {
				handleVersionMismatch(ws, msg.serverVersion); return;
			}
			logEvent({
				direction: 'local',
				kind: 'fatal',
				summary: `server error: ${msg.reason}`,
				details: { reason: msg.reason },
			});
			appendMessage({
				sender: 'system',
				text: `Server error: ${msg.reason}`,
				isSelf: false,
				system: true,
			});
		}
	};

	ws.onClose = () => {
		if (current.phase === 'joining' || current.phase === 'landing') {
			logEvent({
				direction: 'local',
				kind: 'fatal',
				summary: 'connection failed',
				details: { server },
			});
			appendMessage({
				sender: 'system',
				text: 'Connection failed. Is the server running?',
				isSelf: false,
				system: true,
			});
		}
	};
}

function doJoin(
	invite: InvitePayload,
	username: string,
	isReconnect = false,
): void {
	const dns = invite.dns ?? 'localhost:1337';
	if (!isReconnect) resetEvents();
	const ws = new WS(wsUrl(dns));
	attachWireTaps(ws);
	current = {
		phase: 'joining',
		roomId: invite.roomId,
		roomSecret: invite.roomSecret,
		dns,
		username,
	};

	logEvent({
		direction: 'local',
		kind: isReconnect ? 'reconnect' : 'phase',
		summary: isReconnect
			? `reconnecting to ${dns}`
			: `joining ${invite.roomId} on ${dns} as ${username}`,
		details: {
			roomId: invite.roomId,
			roomSecret: redact(invite.roomSecret),
			dns,
			username,
			isReconnect,
		},
	});

	ws.onOpen = () =>
		ws.send({
			type: 'join',
			roomId: invite.roomId,
			roomSecret: invite.roomSecret,
			protocolVersion: PROTOCOL_VERSION,
		});

	ws.onMessage = (msg) => {
		if (msg.type === 'joined') {
			if (msg.serverVersion !== PROTOCOL_VERSION) {
				handleVersionMismatch(ws, msg.serverVersion); return;
			}
			doConnect(
				ws,
				invite.roomId,
				invite.roomSecret,
				dns,
				username,
				msg.members,
				isReconnect,
			);
		} else if (msg.type === 'error') {
			if (msg.reason === 'version_mismatch') {
				handleVersionMismatch(ws, msg.serverVersion); return;
			}
			logEvent({
				direction: 'local',
				kind: 'fatal',
				summary: `server error: ${msg.reason}`,
				details: { reason: msg.reason },
			});
			appendMessage({
				sender: 'system',
				text: `Server error: ${msg.reason}`,
				isSelf: false,
				system: true,
			});
		}
	};

	ws.onClose = () => {
		if (current.phase === 'joining') {
			logEvent({
				direction: 'local',
				kind: 'fatal',
				summary: 'connection failed',
				details: { dns },
			});
			appendMessage({
				sender: 'system',
				text: 'Connection failed. Is the server running?',
				isSelf: false,
				system: true,
			});
		}
	};
}

function doConnect(
	ws: WS,
	roomId: string,
	roomSecret: string,
	dns: string,
	username: string,
	members: { username: string; ek: string; ratchetEk: string; claim: string }[],
	isReconnect = false,
): void {
	let session = new Session(generateKeypair(), roomId);
	const peers = new Map<string, PeerInfo>();
	let chainsExpected = 0;
	let chainsReceived = 0;
	let pendingRekey = false;

	const selfClaim = session.identity.buildClaim(
		session.ratchetEk,
		username,
		roomId,
		session.epoch,
	);
	ws.send({
		type: 'identify',
		username,
		ek: b64enc(session.ek),
		ratchetEk: b64enc(session.ratchetEk),
		claim: b64enc(selfClaim),
	});

	for (const m of members) {
		try {
			session.identity.acceptClaim(m.username, b64dec(m.claim));
		} catch (err) {
			logEvent({
				direction: 'local',
				kind: 'claim-reject',
				summary: `${m.username}: identity claim rejected`,
				details: {
					username: m.username,
					error: err instanceof Error ? err.message : 'invalid',
				},
			});
			if (_showSystem)
				appendMessage({
					sender: 'system',
					text: `[${m.username}: identity claim rejected (${err instanceof Error ? err.message : 'invalid'})]`,
					isSelf: false,
					system: true,
				});
			continue;
		}
		const blob = session.wrapChainSeedFor(b64dec(m.ek), m.username);
		ws.send({ type: 'relay', to: m.username, payload: b64enc(prefixTag(RELAY_TAG_SEED, blob)) });
		const fp = session.identity.peerFingerprint(m.username);
		if (!fp) continue;
		peers.set(m.username, {
			ek: m.ek,
			ratchetEk: m.ratchetEk,
			colorIdx: peers.size + 1,
			fingerprint: fp,
		});
		session.updatePeerRatchetEk(m.username, b64dec(m.ratchetEk));
		chainsExpected++;
		logEvent({
			direction: 'local',
			kind: isReconnect ? 'rejoin' : 'join',
			summary: isReconnect
				? `${m.username} reconnected`
				: `${m.username} joined`,
			details: { username: m.username, fpHex: fp.hex },
		});
	}

	current = {
		phase: 'waiting',
		roomId,
		roomSecret,
		dns,
		session,
		ws,
		username,
		peers,
	};
	if (members.length === 0) {
		renderWaiting(_screen, {
			armoredInvite: makeArmoredInvite(roomId, roomSecret, dns),
			roomId,
		});
	}

	function doLobbyTransition(): void {
		if (current.phase !== 'ready') return;
		logEvent({
			direction: 'local',
			kind: 'phase',
			summary: 'all peers left; entering lobby',
			details: {},
		});
		if (_showSystem)
			appendMessage({
				sender: 'system',
				text: 'All peers left. Waiting for someone to rejoin\u2026',
				isSelf: false,
				system: true,
			});
		disposeAllInbound();
		current.session.dispose();
		session = new Session(generateKeypair(), roomId);
		chainsExpected = 0;
		chainsReceived = 0;
		pendingRekey = true;
		const claim = session.identity.buildClaim(
			session.ratchetEk,
			username,
			roomId,
			session.epoch,
		);
		ws.send({
			type: 'rekey',
			ek: b64enc(session.ek),
			ratchetEk: b64enc(session.ratchetEk),
			claim: b64enc(claim),
		});
	}

	ws.onMessage = (msg) => {
		if (msg.type === 'rekeyed' && pendingRekey) {
			pendingRekey = false;
			current = {
				phase: 'waiting',
				roomId,
				roomSecret,
				dns,
				session,
				ws,
				username,
				peers,
			};
			renderWaiting(_screen, {
				armoredInvite: makeArmoredInvite(roomId, roomSecret, dns),
				roomId,
			});
			return;
		}

		if (msg.type === 'peer_joined') {
			if (current.phase !== 'waiting' && current.phase !== 'ready') return;
			const st = current;
			try {
				st.session.identity.acceptClaim(msg.username, b64dec(msg.claim));
			} catch (err) {
				logEvent({
					direction: 'local',
					kind: 'claim-reject',
					summary: `${msg.username}: identity claim rejected`,
					details: {
						username: msg.username,
						error: err instanceof Error ? err.message : 'invalid',
					},
				});
				if (_showSystem)
					appendMessage({
						sender: 'system',
						text: `[${msg.username}: identity claim rejected (${err instanceof Error ? err.message : 'invalid'})]`,
						isSelf: false,
						system: true,
					});
				return;
			}
			const prev = st.peers.get(msg.username);
			const peerEk = b64dec(msg.ek);
			const blob = st.session.wrapChainSeedFor(peerEk, msg.username);
			ws.send({ type: 'relay', to: msg.username, payload: b64enc(prefixTag(RELAY_TAG_SEED, blob)) });
			st.session.updatePeerRatchetEk(msg.username, b64dec(msg.ratchetEk));
			const fp = st.session.identity.peerFingerprint(msg.username);
			if (!fp) return;
			const fpChanged = !!prev && prev.fingerprint.hex !== fp.hex;
			st.peers.set(msg.username, {
				ek: msg.ek,
				ratchetEk: msg.ratchetEk,
				colorIdx: prev?.colorIdx ?? st.peers.size + 1,
				fingerprint: fp,
			});
			if (_showSystem)
				appendMessage({
					sender: 'system',
					text: `${msg.username} joined`,
					isSelf: false,
					system: true,
				});
			logEvent({
				direction: 'local',
				kind: prev ? 'rejoin' : 'join',
				summary: prev
					? `${msg.username} reconnected${fpChanged ? ' (fp changed)' : ''}`
					: `${msg.username} joined`,
				details: { username: msg.username, fpHex: fp.hex, fpChanged },
			});
			if (current.phase === 'waiting') chainsExpected++;
			return;
		}

		if (msg.type === 'relay') {
			const { tag, body } = readRelayTag(b64dec(msg.payload));
			if (tag === RELAY_TAG_FILE_ACK) {
				const { fileId, seq } = decodeFileAck(body);
				const sf = sendingFiles.get(fileId);
				if (sf && sf.recipients.has(msg.from) && seq > (sf.acked.get(msg.from) ?? -1))
					sf.acked.set(msg.from, seq);
				return;
			}
			if (current.phase === 'waiting') {
				const st = current;
				st.session.unwrapChainSeed(msg.from, body);
				const peerInfo = st.peers.get(msg.from);
				if (peerInfo)
					st.session.updatePeerRatchetEk(msg.from, b64dec(peerInfo.ratchetEk));
				chainsReceived++;
				if (chainsReceived >= chainsExpected && chainsExpected > 0) {
					current = {
						phase: 'ready',
						roomId,
						roomSecret,
						dns,
						session: st.session,
						ws,
						username,
						peers: st.peers,
					};
					logEvent({
						direction: 'local',
						kind: 'phase',
						summary: 'session ready',
						details: { peerCount: st.peers.size },
					});
					if (isReconnect && _connectionLostAt > 0) {
						const downMs = Date.now() - _connectionLostAt;
						logEvent({
							direction: 'local',
							kind: 'reconnect',
							summary: 'connection restored',
							details: { downMs },
						});
						_connectionLostAt = 0;
					}
					if (!isReconnect)
						renderChat(_screen, {
							username,
							peers: st.peers,
							onSend: doSendMessage,
							onFile: doSendFile,
							onRotate: doRatchetStep,
							getFingerprints: () => {
								// Read from `current` so the active session is used after a
								// reconnect or lobby rekey, not the stale `st` snapshot.
								if (current.phase !== 'ready' && current.phase !== 'waiting')
									return {
										local: st.session.identity.localFingerprint(),
										peers: peerFingerprints(st.peers),
									};
								return {
									local: current.session.identity.localFingerprint(),
									peers: peerFingerprints(current.peers),
								};
							},
						});
					doRatchetStep();
				}
			} else if (current.phase === 'ready') {
				current.session.unwrapChainSeed(msg.from, body);
			}
			return;
		}

		if (msg.type === 'ratchet_step_fwd' && current.phase === 'ready') {
			const st = current;
			try {
				st.session.identity.acceptClaim(msg.from, b64dec(msg.claim));
			} catch (err) {
				logEvent({
					direction: 'local',
					kind: 'claim-reject',
					summary: `${msg.from}: ratchet claim rejected`,
					details: {
						from: msg.from,
						error: err instanceof Error ? err.message : 'invalid',
					},
				});
				if (_showSystem)
					appendMessage({
						sender: 'system',
						text: `[${msg.from}: ratchet claim rejected (${err instanceof Error ? err.message : 'invalid'})]`,
						isSelf: false,
						system: true,
					});
				return;
			}
			st.session.receiveRatchetStep(
				msg.from,
				b64dec(msg.kemCt),
				b64dec(msg.encSeed),
				msg.pn,
			);
			st.session.updatePeerRatchetEk(msg.from, b64dec(msg.newEk));
			const pi = st.peers.get(msg.from);
			if (pi) st.peers.set(msg.from, { ...pi, ratchetEk: msg.newEk });
			const ekClaim = st.session.identity.buildClaim(
				st.session.ratchetEk,
				st.username,
				roomId,
				st.session.epoch,
			);
			ws.send({
				type: 'ek_update',
				ek: b64enc(st.session.ratchetEk),
				claim: b64enc(ekClaim),
			});
			logEvent({
				direction: 'in',
				kind: 'ratchet',
				summary: `${msg.from}: keys rotated`,
				details: { from: msg.from },
			});
			// verify + open the sentinel payload to advance the chain; plaintext discarded
			const meta = msg.meta as unknown as MessageEnvelope;
			const ciphertext = b64dec(msg.payload);
			const sig = b64dec(msg.sig);
			const verified = st.session.identity.verifyMessage(
				msg.from,
				meta.counter,
				meta.epoch ?? 0,
				meta.sender,
				meta.ts,
				ciphertext,
				sig,
			);
			if (!verified) {
				logEvent({
					direction: 'local',
					kind: 'verify-fail',
					summary: `${msg.from}: ratchet message signature invalid`,
					details: { from: msg.from },
				});
				if (_showSystem)
					appendMessage({
						sender: 'system',
						text: `[${msg.from}: ratchet message signature invalid]`,
						isSelf: false,
						system: true,
					});
				return;
			}
			try {
				st.session.openMessage(
					msg.from,
					meta.epoch ?? 0,
					meta.counter,
					ciphertext,
				);
			} catch (err) {
				const detail = err instanceof Error ? err.message : 'decryption failed';
				logEvent({
					direction: 'local',
					kind: 'decrypt-fail',
					summary: `${msg.from}: ratchet decrypt failed`,
					details: { from: msg.from, error: detail },
				});
				if (_showSystem)
					appendMessage({
						sender: 'system',
						text: `[${msg.from}: ratchet decrypt failed (${detail})]`,
						isSelf: false,
						system: true,
					});
				return;
			}
			appendMessage({
				sender: msg.from,
				text: RATCHET_LABEL,
				isSelf: false,
				senderIndex: colorIdxFor(msg.from, st.peers),
				ratchet: true,
				ratchetIcon: _keysIcon,
			});
			return;
		}

		if (msg.type === 'ek_update_fwd') {
			if (current.phase !== 'ready' && current.phase !== 'waiting') return;
			try {
				current.session.identity.acceptClaim(msg.from, b64dec(msg.claim));
			} catch (err) {
				if (_showSystem)
					appendMessage({
						sender: 'system',
						text: `[${msg.from}: ek_update claim rejected (${err instanceof Error ? err.message : 'invalid'})]`,
						isSelf: false,
						system: true,
					});
				return;
			}
			current.session.updatePeerRatchetEk(msg.from, b64dec(msg.ek));
			const pi = current.peers.get(msg.from);
			if (pi) current.peers.set(msg.from, { ...pi, ratchetEk: msg.ek });
			return;
		}

		if (msg.type === 'broadcast' && current.phase === 'ready') {
			try {
				doReceiveMessage(
					current,
					msg.from,
					msg.payload,
					msg.meta as unknown as MessageEnvelope,
					msg.sig,
				);
			} catch (err: unknown) {
				if (_showSystem) {
					const text = err instanceof Error ? err.message : 'decryption failed';
					appendMessage({
						sender: 'system',
						text: `[${msg.from}: ${text}]`,
						isSelf: false,
						system: true,
					});
				}
			}
			return;
		}

		if (msg.type === 'peer_left') {
			if (current.phase !== 'ready' && current.phase !== 'waiting') return;
			disposeInboundForPeer(msg.username);
			current.session.removePeer(msg.username);
			current.peers.delete(msg.username);
			logEvent({
				direction: 'local',
				kind: 'part',
				summary: `${msg.username} left`,
				details: { username: msg.username },
			});
			if (current.phase === 'ready') {
				if (_showSystem)
					appendMessage({
						sender: 'system',
						text: `${msg.username} left the room`,
						isSelf: false,
						system: true,
					});
				if (current.peers.size === 0) doLobbyTransition();
			}
			return;
		}

		if (msg.type === 'error') {
			if (msg.reason === 'username_taken') {
				logEvent({
					direction: 'local',
					kind: 'fatal',
					summary: 'username_taken',
					details: { reason: msg.reason },
				});
				// dispose and close the ghost connection before going back to landing
				disposeAllInbound();
				session.dispose();
				ws.close();
				returnToLanding(USERNAME_TAKEN_MSG, { server: dns, username });
			} else {
				logEvent({
					direction: 'local',
					kind: 'fatal',
					summary: `server error: ${msg.reason}`,
					details: { reason: msg.reason },
				});
				if (_showSystem)
					appendMessage({
						sender: 'system',
						text: `Server error: ${msg.reason}`,
						isSelf: false,
						system: true,
					});
			}
		}
	};

	ws.onClose = () => {
		if (_shuttingDown) return;
		if (current.phase !== 'ready' && current.phase !== 'waiting') return;
		disposeAllInbound();
		current.session.dispose();
		_connectionLostAt = Date.now();
		logEvent({
			direction: 'local',
			kind: 'reconnect',
			summary: 'connection lost',
			details: {},
		});
		if (_showSystem)
			appendMessage({
				sender: 'system',
				text: 'Connection lost. Reconnecting\u2026',
				isSelf: false,
				system: true,
			});
		startReconnect(roomId, roomSecret, dns, username);
	};
}

function startReconnect(
	roomId: string,
	roomSecret: string,
	dns: string,
	username: string,
): void {
	let delay = 1000;
	const attempt = async () => {
		if (_shuttingDown) return;
		try {
			const res = await fetch(`${httpUrl(dns)}/health_check`);
			if (res.ok) {
				doJoin(
					{ version: INVITE_VERSION, roomId, roomSecret, dns },
					username,
					true,
				);
				return;
			}
		} catch {
			/* server not yet reachable */
		}
		delay = Math.min(delay * 2, 30000);
		setTimeout(attempt, delay);
	};
	setTimeout(attempt, delay);
}

// Generic on-screen copy: no version numbers (the event-log sidebar isn't
// available at landing anyway). Exact numbers go to stderr for debugging.
const VERSION_MISMATCH_MSG = 'This server is running a different version.';
const USERNAME_TAKEN_MSG = 'That username is taken in this room.';

function returnToLanding(
	error: string,
	config: { server?: string; username?: string } = {},
): void {
	current = { phase: 'landing' };
	renderLanding(_screen, {
		config,
		error,
		onCreate: doCreate,
		onJoinClick: (u) =>
			renderJoin(_screen, {
				username: u,
				onConnect: (inv) => doJoin(inv, u),
			}),
	});
}

// Fires on a version_mismatch error from the server (old client to new server)
// or a failed serverVersion check (new client to old server). The connection is
// unusable either way; close it and bail to landing with a generic message.
function handleVersionMismatch(ws: WS, got: number | undefined): void {
	process.stderr.write(`covcom: server protocol version mismatch (expected ${PROTOCOL_VERSION}, got ${got ?? 'none'})\n`);
	logEvent({
		direction: 'local',
		kind: 'fatal',
		summary: 'version_mismatch',
		details: { expected: PROTOCOL_VERSION, got: got ?? null },
	});
	ws.close();
	returnToLanding(VERSION_MISMATCH_MSG);
}

function doSendMessage(text: string): void {
	if (current.phase !== 'ready') return;
	const st = current;
	if (st.session.counter >= PROTOCOL.autoRatchetEvery && st.peers.size > 0)
		doRatchetStep();
	const bytes = new TextEncoder().encode(text);
	const { ciphertext, counter, epoch } = st.session.sealMessage(bytes);
	const ts = Date.now();
	const sig = st.session.identity.signMessage(
		counter,
		epoch,
		st.username,
		ts,
		ciphertext,
	);
	const meta: MessageEnvelope = {
		type: 'message',
		sender: st.username,
		counter,
		epoch,
		ts,
	};
	st.ws.send({
		type: 'broadcast',
		payload: b64enc(ciphertext),
		meta: meta as unknown as Record<string, unknown>,
		sig: b64enc(sig),
	});
	const idx = st.peers.get(st.username)?.colorIdx ?? 0;
	appendMessage({ sender: st.username, text, isSelf: true, senderIndex: idx });
	logEvent({
		direction: 'out',
		kind: 'message',
		summary: `${st.username}: ${text.slice(0, 40)}`,
		details: { from: st.username, epoch, counter },
	});
}

// Streams the file as a `file-begin` frame (SealStream preamble + metadata) then
// one signed `file-chunk` broadcast per chunk, reading the file in FILE_CHUNK_SIZE
// slices. Peak memory is O(chunkSize) and no frame nears the broker's 16 MiB cap.
async function doSendFile(filePath: string): Promise<void> {
	if (current.phase !== 'ready') return;
	const st = current;
	if (st.session.counter >= PROTOCOL.autoRatchetEvery && st.peers.size > 0)
		doRatchetStep();
	const ts     = Date.now();
	const fileId = crypto.randomUUID();
	const { msgKey, counter, epoch } = st.session.sealFileKey();
	let stream: SealStream | null = null;
	try {
		const bunFile  = Bun.file(filePath);
		const filename = basename(filePath);
		const size     = bunFile.size;
		const mime     = bunFile.type || 'application/octet-stream';
		stream = new SealStream(XChaCha20Cipher, msgKey, { chunkSize: FILE_CHUNK_SIZE });
		const beginSig = st.session.identity.signMessage(counter, epoch, st.username, ts, stream.preamble);
		const beginMeta: MessageEnvelope = {
			type: 'file-begin', sender: st.username, counter, epoch, ts,
			fileId, filename, size, mime, chunkSize: FILE_CHUNK_SIZE, preamble: b64enc(stream.preamble),
		};
		st.ws.send({
			type: 'broadcast',
			payload: b64enc(stream.preamble),
			meta: beginMeta as unknown as Record<string, unknown>,
			sig: b64enc(beginSig),
		});
		// Snapshot recipients now; a peer joining mid-transfer missed file-begin
		// and is not a recipient. Empty set (self/lobby) means no pacing.
		const acked = new Map<string, number>();
		for (const p of st.peers.keys()) acked.set(p, -1);
		sendingFiles.set(fileId, { recipients: new Set(st.peers.keys()), acked });

		const s = stream;
		await forEachChunk(
			async (offset, len) => new Uint8Array(await bunFile.slice(offset, offset + len).arrayBuffer()),
			size,
			FILE_CHUNK_SIZE,
			async (chunk, seq, final) => {
				await waitForCredit(fileId, seq, st.ws);
				if (!st.ws.isOpen()) throw new Error('connection lost during file send');
				const ct  = final ? s.finalize(chunk) : s.push(chunk);
				const sig = st.session.identity.signMessage(counter, epoch, st.username, ts, ct);
				const meta: MessageEnvelope = {
					type: 'file-chunk', sender: st.username, counter, epoch, ts, fileId, seq, final,
				};
				st.ws.send({
					type: 'broadcast',
					payload: b64enc(ct),
					meta: meta as unknown as Record<string, unknown>,
					sig: b64enc(sig),
				});
			},
		);
		const idx = st.peers.get(st.username)?.colorIdx ?? 0;
		appendFile({ sender: st.username, filename, size, mime, isSelf: true, senderIndex: idx });
		logEvent({
			direction: 'out',
			kind: 'file',
			summary: `${st.username}: ${filename}`,
			details: { from: st.username, filename, size, mime },
		});
	} catch (e) {
		appendMessage({
			sender: 'system',
			text: `Send failed: ${e instanceof Error ? e.message : String(e)}`,
			isSelf: false,
			system: true,
		});
	} finally {
		sendingFiles.delete(fileId);
		stream?.dispose();
		wipe(msgKey);
	}
}

function colorIdxFor(from: string, peers: Map<string, PeerInfo>): number {
	return peers.get(from)?.colorIdx ?? peers.size;
}

function doReceiveMessage(
	state: AppState & { phase: 'ready' },
	from: string,
	payloadBase64: string,
	meta: MessageEnvelope,
	sigBase64: string,
): void {
	const ciphertext = b64dec(payloadBase64);
	const sig = b64dec(sigBase64);
	const ok = state.session.identity.verifyMessage(
		from,
		meta.counter,
		meta.epoch ?? 0,
		meta.sender,
		meta.ts,
		ciphertext,
		sig,
	);
	if (!ok) {
		if (meta.type === 'file-begin' || meta.type === 'file-chunk')
			disposeInbound(`${from}|${meta.fileId}`);
		throw new Error('message signature verification failed');
	}
	const senderIdx = colorIdxFor(from, state.peers);

	if (meta.type === 'message') {
		const plain = state.session.openMessage(
			from,
			meta.epoch ?? 0,
			meta.counter,
			ciphertext,
		);
		const text = new TextDecoder().decode(plain);
		appendMessage({
			sender: from,
			text,
			isSelf: false,
			senderIndex: senderIdx,
		});
		logEvent({
			direction: 'in',
			kind: 'message',
			summary: `${from}: ${text.slice(0, 40)}`,
			details: { from, epoch: meta.epoch ?? 0, counter: meta.counter },
		});
	} else if (meta.type === 'file-begin') {
		const key = `${from}|${meta.fileId}`;
		disposeInbound(key);   // drop any stale transfer reusing this id
		let h: { key: Uint8Array; commit: () => void; rollback: () => void };
		try {
			h = state.session.openFileKey(from, meta.epoch ?? 0, meta.counter);
		} catch (e) {
			appendMessage({ sender: 'system', text: `File receive failed: ${e instanceof Error ? e.message : String(e)}`, isSelf: false, system: true });
			return;
		}
		let opener: OpenStream;
		try {
			opener = new OpenStream(XChaCha20Cipher, h.key, ciphertext);
		} catch (e) {
			h.rollback();
			appendMessage({ sender: 'system', text: `File receive failed: ${e instanceof Error ? e.message : String(e)}`, isSelf: false, system: true });
			return;
		}
		inboundFiles.set(key, {
			opener, handle: h, chunks: [], nextSeq: 0,
			filename: meta.filename ?? 'file',
			mime: meta.mime ?? 'application/octet-stream',
			size: meta.size ?? 0, senderIdx,
		});
	} else if (meta.type === 'file-chunk') {
		const key = `${from}|${meta.fileId}`;
		const f   = inboundFiles.get(key);
		if (!f) return;
		if ((meta.seq ?? -1) !== f.nextSeq) {
			disposeInbound(key);
			appendMessage({ sender: 'system', text: `[${from}: out-of-order file chunk, dropping transfer]`, isSelf: false, system: true });
			return;
		}
		let plain: Uint8Array;
		try {
			plain = meta.final ? f.opener.finalize(ciphertext) : f.opener.pull(ciphertext);
		} catch (e) {
			f.handle.rollback();
			inboundFiles.delete(key);
			appendMessage({ sender: 'system', text: `File receive failed: ${e instanceof Error ? e.message : String(e)}`, isSelf: false, system: true });
			return;
		}
		f.chunks.push(plain);
		f.nextSeq++;
		// Ack consumed seq so the sender can advance its window. Twice per window
		// plus the terminator; the sender paces to the slowest recipient's ack.
		const seq = meta.seq ?? 0;
		if (seq % ACK_INTERVAL === 0 || meta.final)
			state.ws.send({ type: 'relay', to: from, payload: b64enc(encodeFileAck(meta.fileId ?? '', seq)) });
		if (meta.final) {
			f.handle.commit();
			inboundFiles.delete(key);
			const { filename, size, mime, chunks, senderIdx: idx } = f;
			const download = async (): Promise<string> => {
				const outPath = resolveUniqueFilename(join(process.cwd(), filename));
				try {
					await Bun.write(outPath, new Blob(chunks, { type: mime }));
				} catch (err) {
					appendMessage({ sender: 'system', text: `Save failed: ${err instanceof Error ? err.message : String(err)}`, isSelf: false, system: true });
					throw err;
				}
				showModal({ title: 'File Downloaded', body: `${filename}\n${outPath}` });
				logEvent({ direction: 'in', kind: 'file', summary: `${from}: ${filename} → ${basename(outPath)}`, details: { from, filename, size, saved: outPath } });
				return outPath;
			};
			appendFile({ sender: from, filename, size, mime, isSelf: false, senderIndex: idx, download });
			logEvent({ direction: 'in', kind: 'file', summary: `${from}: ${filename} (pending)`, details: { from, filename, size } });
		}
	}
}

function doRatchetStep(): void {
	if (current.phase !== 'ready') return;
	if (current.peers.size === 0) return;
	const st = current;
	const payloads: Record<
    string,
    { kemCt: string; encSeed: string; pn: number }
  > = {};
	for (const [peerUsername] of st.peers) {
		const { kemCt, encSeed, pn } = st.session.performRatchetStep(peerUsername);
		payloads[peerUsername] = {
			kemCt: b64enc(kemCt),
			encSeed: b64enc(encSeed),
			pn,
		};
	}
	st.session.commitRatchetStep();
	appendMessage({
		sender: st.username,
		text: RATCHET_LABEL,
		isSelf: true,
		senderIndex: 0,
		ratchet: true,
		ratchetIcon: _keysIcon,
	});
	logEvent({
		direction: 'out',
		kind: 'ratchet',
		summary: `${st.username}: keys rotated`,
		details: { from: st.username, peers: Object.keys(payloads).join(', ') },
	});
	const bytes = new TextEncoder().encode('[\uD83D\uDD12 keys rotated]');
	const { ciphertext, counter, epoch } = st.session.sealMessage(bytes);
	const ts = Date.now();
	const sig = st.session.identity.signMessage(
		counter,
		epoch,
		st.username,
		ts,
		ciphertext,
	);
	const claim = st.session.identity.buildClaim(
		st.session.ratchetEk,
		st.username,
		st.session.roomId,
		epoch,
	);
	const meta: MessageEnvelope = {
		type: 'message',
		sender: st.username,
		counter,
		epoch,
		ts,
	};
	st.ws.send({
		type: 'ratchet_step',
		payloads,
		newEk: b64enc(st.session.ratchetEk),
		payload: b64enc(ciphertext),
		meta: meta as unknown as Record<string, unknown>,
		sig: b64enc(sig),
		claim: b64enc(claim),
	});
}
