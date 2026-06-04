import { cpus } from 'os';
import { join, basename } from 'path';
import {
	chacha20Wasm,
	generateKeypair,
	Session,
	serializeInvite,
	armorInvite,
	INVITE_VERSION,
	SealStreamPool,
	wipe,
} from '@covcom/lib';
import { XChaCha20CipherBun } from './cipher-suites.js';
import type {
	InvitePayload,
	MessageEnvelope,
	FingerprintSurface,
} from '@covcom/lib';
import { WS } from './ws.js';
import type { InboundMsg, OutboundMsg } from './ws.js';
import { b64enc, b64dec, wsUrl, resolveUniqueFilename } from './util.js';
import { writeConfig } from './config.js';
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

function ratchetDisplayText(): string {
	return _keysIcon ? `${_keysIcon} keys rotated` : 'keys rotated';
}

const workerCount = cpus().length || 4;

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
): { username: string; fingerprint: FingerprintSurface }[] {
	const out: { username: string; fingerprint: FingerprintSurface }[] = [];
	for (const [username, info] of peers)
		out.push({ username, fingerprint: info.fingerprint });
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
		writeConfig({ server: dns, username });
		ws.send({ type: 'create', adminToken });
	};

	ws.onMessage = (msg) => {
		if (msg.type === 'room_created') {
			roomId = msg.roomId;
			roomSecret = msg.roomSecret;
			current = { phase: 'joining', roomId, roomSecret, dns, username };
			ws.send({ type: 'join', roomId, roomSecret });
		} else if (msg.type === 'joined') {
			doConnect(ws, roomId, roomSecret, dns, username, msg.members);
		} else if (msg.type === 'error') {
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
				senderIndex: 7,
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
				senderIndex: 7,
			});
		}
	};
}

function doJoin(
	invite: InvitePayload,
	username: string,
	isReconnect = false,
): void {
	const dns = invite.dns ?? 'localhost:3000';
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
		});

	ws.onMessage = (msg) => {
		if (msg.type === 'joined') {
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
				senderIndex: 7,
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
				senderIndex: 7,
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
					senderIndex: 7,
				});
			continue;
		}
		const blob = session.wrapChainSeedFor(b64dec(m.ek), m.username);
		ws.send({ type: 'relay', to: m.username, payload: b64enc(blob) });
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

	registerCleanup(() => {
		if (current.phase === 'waiting' || current.phase === 'ready') {
			current.session.dispose();
			current.ws.close();
		}
	});

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
				senderIndex: 7,
			});
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
						senderIndex: 7,
					});
				return;
			}
			const prev = st.peers.get(msg.username);
			const peerEk = b64dec(msg.ek);
			const blob = st.session.wrapChainSeedFor(peerEk, msg.username);
			ws.send({ type: 'relay', to: msg.username, payload: b64enc(blob) });
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
					senderIndex: 7,
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
			if (current.phase === 'waiting') {
				const st = current;
				st.session.unwrapChainSeed(msg.from, b64dec(msg.payload));
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
				current.session.unwrapChainSeed(msg.from, b64dec(msg.payload));
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
						senderIndex: 7,
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
						senderIndex: 7,
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
						senderIndex: 7,
					});
				return;
			}
			appendMessage({
				sender: msg.from,
				text: ratchetDisplayText(),
				isSelf: false,
				senderIndex: colorIdxFor(msg.from, st.peers),
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
						senderIndex: 7,
					});
				return;
			}
			current.session.updatePeerRatchetEk(msg.from, b64dec(msg.ek));
			const pi = current.peers.get(msg.from);
			if (pi) current.peers.set(msg.from, { ...pi, ratchetEk: msg.ek });
			return;
		}

		if (msg.type === 'broadcast' && current.phase === 'ready') {
			doReceiveMessage(
				current,
				msg.from,
				msg.payload,
        msg.meta as unknown as MessageEnvelope,
        msg.sig,
			).catch((err: unknown) => {
				if (_showSystem) {
					const text = err instanceof Error ? err.message : 'decryption failed';
					appendMessage({
						sender: 'system',
						text: `[${msg.from}: ${text}]`,
						isSelf: false,
						senderIndex: 7,
					});
				}
			});
			return;
		}

		if (msg.type === 'peer_left') {
			if (current.phase !== 'ready' && current.phase !== 'waiting') return;
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
						senderIndex: 7,
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
				session.dispose();
				ws.close();
				current = { phase: 'landing' };
				renderLanding(_screen, {
					config: {},
					onCreate: doCreate,
					onJoinClick: (u) =>
						renderJoin(_screen, {
							username: u,
							onConnect: (inv) => doJoin(inv, u),
						}),
				});
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
						senderIndex: 7,
					});
			}
		}
	};

	ws.onClose = () => {
		if (current.phase !== 'ready' && current.phase !== 'waiting') return;
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
				senderIndex: 7,
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

const AUTO_RATCHET_INTERVAL = 25;

function doSendMessage(text: string): void {
	if (current.phase !== 'ready') return;
	const st = current;
	if (st.session.counter >= AUTO_RATCHET_INTERVAL && st.peers.size > 0)
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

async function doSendFile(filePath: string): Promise<void> {
	if (current.phase !== 'ready') return;
	const st = current;
	if (st.session.counter >= AUTO_RATCHET_INTERVAL && st.peers.size > 0)
		doRatchetStep();
	const { msgKey, counter, epoch } = st.session.sealFileKey();
	let pool: SealStreamPool | null = null;
	try {
		const bunFile = Bun.file(filePath);
		const bytes = new Uint8Array(await bunFile.arrayBuffer());
		const filename = basename(filePath);
		const size = bytes.length;
		const mime = bunFile.type || 'application/octet-stream';
		pool = await SealStreamPool.create(XChaCha20CipherBun, msgKey, {
			wasm: chacha20Wasm,
			workers: workerCount,
			chunkSize: 65536,
		});
		const ciphertext = await pool.seal(bytes);
		const ts = Date.now();
		const sig = st.session.identity.signMessage(
			counter,
			epoch,
			st.username,
			ts,
			ciphertext,
		);
		const meta: MessageEnvelope = {
			type: 'file',
			sender: st.username,
			counter,
			epoch,
			ts,
			filename,
			size,
			mime,
		};
		st.ws.send({
			type: 'broadcast',
			payload: b64enc(ciphertext),
			meta: meta as unknown as Record<string, unknown>,
			sig: b64enc(sig),
		});
		const idx = st.peers.get(st.username)?.colorIdx ?? 0;
		appendFile({
			sender: st.username,
			filename,
			size,
			mime,
			isSelf: true,
			senderIndex: idx,
		});
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
			senderIndex: 7,
		});
	} finally {
		pool?.destroy();
		wipe(msgKey);
	}
}

function colorIdxFor(from: string, peers: Map<string, PeerInfo>): number {
	return peers.get(from)?.colorIdx ?? peers.size;
}

async function doReceiveMessage(
	state: AppState & { phase: 'ready' },
	from: string,
	payloadBase64: string,
	meta: MessageEnvelope,
	sigBase64: string,
): Promise<void> {
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
	if (!ok) throw new Error('message signature verification failed');
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
	} else if (meta.type === 'file') {
		const h = state.session.openFileKey(from, meta.epoch ?? 0, meta.counter);
		let pool: SealStreamPool | null = null;
		let settled = false;
		try {
			pool = await SealStreamPool.create(XChaCha20CipherBun, h.key, {
				wasm: chacha20Wasm,
			});
			const plain = await pool.open(ciphertext);
			h.commit();
			settled = true;
			const filename = meta.filename ?? 'file';
			const size = meta.size ?? plain.length;
			const download = async (): Promise<string> => {
				const outPath = resolveUniqueFilename(join(process.cwd(), filename));
				try {
					await Bun.write(outPath, plain);
				} catch (err) {
					appendMessage({
						sender: 'system',
						text: `Save failed: ${err instanceof Error ? err.message : String(err)}`,
						isSelf: false,
						senderIndex: 7,
					});
					throw err;
				}
				showModal({
					title: 'File Downloaded',
					body: `${filename}\n${outPath}`,
				});
				logEvent({
					direction: 'in',
					kind: 'file',
					summary: `${from}: ${filename} → ${basename(outPath)}`,
					details: { from, filename, size, saved: outPath },
				});
				return outPath;
			};
			appendFile({
				sender: from,
				filename,
				size,
				mime: meta.mime ?? 'application/octet-stream',
				isSelf: false,
				senderIndex: senderIdx,
				download,
			});
			logEvent({
				direction: 'in',
				kind: 'file',
				summary: `${from}: ${filename} (pending)`,
				details: { from, filename, size },
			});
		} catch (e) {
			if (!settled) h.rollback();
			appendMessage({
				sender: 'system',
				text: `File receive failed: ${e instanceof Error ? e.message : String(e)}`,
				isSelf: false,
				senderIndex: 7,
			});
		} finally {
			pool?.destroy();
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
		text: ratchetDisplayText(),
		isSelf: true,
		senderIndex: 0,
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
