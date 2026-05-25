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
import type { InvitePayload, MessageEnvelope, FingerprintSurface } from '@covcom/lib';
import { WS } from './ws.js';
import { b64enc, b64dec, wsUrl, resolveUniqueFilename } from './util.js';
import { writeConfig } from './config.js';
import { registerCleanup } from './lifecycle.js';
import { renderLanding } from './tui/landing.js';
import { renderWaiting } from './tui/waiting.js';
import { renderJoin } from './tui/join.js';
import { renderChat, appendMessage, appendFile } from './tui/chat.js';

type Screen = Parameters<typeof renderLanding>[0]

interface PeerInfo {
  ek: string;
  ratchetEk: string;
  colorIdx: number;
  fingerprint: FingerprintSurface;
}

type AppState =
  | { phase: 'landing' }
  | {
      phase:      'joining';
      roomId:     string;
      roomSecret: string;
      dns:        string;
      username:   string;
    }
  | {
      phase:      'waiting';
      roomId:     string;
      roomSecret: string;
      dns:        string;
      session:    Session;
      ws:         WS;
      username:   string;
      peers:      Map<string, PeerInfo>;
    }
  | {
      phase:      'ready';
      roomId:     string;
      roomSecret: string;
      dns:        string;
      session:    Session;
      ws:         WS;
      username:   string;
      peers:      Map<string, PeerInfo>;
    };

let current: AppState = { phase: 'landing' };
let _screen: Screen;
let _showSystem = true;

const workerCount = cpus().length || 4;

function makeArmoredInvite(roomId: string, roomSecret: string, dns?: string): string {
	return armorInvite(serializeInvite({ version: INVITE_VERSION, roomId, roomSecret, dns }));
}

function httpUrl(server: string): string {
	const host  = server.split(':')[0];
	const local = host === 'localhost' || host.startsWith('127.');
	return `${local ? 'http' : 'https'}://${server}`;
}

function peerFingerprints(peers: Map<string, PeerInfo>): { username: string; fingerprint: FingerprintSurface }[] {
	const out: { username: string; fingerprint: FingerprintSurface }[] = [];
	for (const [username, info] of peers) out.push({ username, fingerprint: info.fingerprint });
	return out;
}

export function mount(
	screen: Screen,
	config: { server?: string; username?: string; systemMessages?: boolean },
	joinArg?: string,
): void {
	_screen = screen;
	_showSystem = config.systemMessages !== false;
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
	const ws  = new WS(wsUrl(server));
	const dns = server;
	let roomId     = '';
	let roomSecret = '';

	ws.onOpen = () => {
		writeConfig({ server: dns, username });
		ws.send({ type: 'create', adminToken });
	};

	ws.onMessage = (msg) => {
		if (msg.type === 'room_created') {
			roomId     = msg.roomId;
			roomSecret = msg.roomSecret;
			current    = { phase: 'joining', roomId, roomSecret, dns, username };
			ws.send({ type: 'join', roomId, roomSecret });
		} else if (msg.type === 'joined') {
			doConnect(ws, roomId, roomSecret, dns, username, msg.members);
		} else if (msg.type === 'error') {
			appendMessage({ sender: 'system', text: `Server error: ${msg.reason}`, isSelf: false, senderIndex: 7 });
		}
	};

	ws.onClose = () => {
		if (current.phase === 'joining' || current.phase === 'landing') {
			appendMessage({ sender: 'system', text: 'Connection failed. Is the server running?', isSelf: false, senderIndex: 7 });
		}
	};
}

function doJoin(invite: InvitePayload, username: string, isReconnect = false): void {
	const dns = invite.dns ?? 'localhost:3000';
	const ws  = new WS(wsUrl(dns));
	current   = { phase: 'joining', roomId: invite.roomId, roomSecret: invite.roomSecret, dns, username };

	ws.onOpen = () => ws.send({ type: 'join', roomId: invite.roomId, roomSecret: invite.roomSecret });

	ws.onMessage = (msg) => {
		if (msg.type === 'joined') {
			doConnect(ws, invite.roomId, invite.roomSecret, dns, username, msg.members, isReconnect);
		} else if (msg.type === 'error') {
			appendMessage({ sender: 'system', text: `Server error: ${msg.reason}`, isSelf: false, senderIndex: 7 });
		}
	};

	ws.onClose = () => {
		if (current.phase === 'joining') {
			appendMessage({ sender: 'system', text: 'Connection failed. Is the server running?', isSelf: false, senderIndex: 7 });
		}
	};
}

function doConnect(
	ws:          WS,
	roomId:      string,
	roomSecret:  string,
	dns:         string,
	username:    string,
	members:     { username: string; ek: string; ratchetEk: string; claim: string }[],
	isReconnect  = false,
): void {
	let session  = new Session(generateKeypair(), roomId);
	const peers  = new Map<string, PeerInfo>();
	let chainsExpected = 0;
	let chainsReceived = 0;
	let pendingRekey   = false;

	const selfClaim = session.identity.buildClaim(session.ratchetEk, username, roomId, session.epoch);
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
			if (_showSystem)
				appendMessage({
					sender: 'system',
					text: `[${m.username}: identity claim rejected (${err instanceof Error ? err.message : 'invalid'})]`,
					isSelf: false, senderIndex: 7,
				});
			continue;
		}
		const blob = session.wrapChainSeedFor(b64dec(m.ek), m.username);
		ws.send({ type: 'relay', to: m.username, payload: b64enc(blob) });
		const fp = session.identity.peerFingerprint(m.username);
		if (!fp) continue;
		peers.set(m.username, { ek: m.ek, ratchetEk: m.ratchetEk, colorIdx: peers.size + 1, fingerprint: fp });
		session.updatePeerRatchetEk(m.username, b64dec(m.ratchetEk));
		chainsExpected++;
	}

	current = { phase: 'waiting', roomId, roomSecret, dns, session, ws, username, peers };
	if (members.length === 0) {
		renderWaiting(_screen, { armoredInvite: makeArmoredInvite(roomId, roomSecret, dns), roomId });
	}

	registerCleanup(() => {
		if (current.phase === 'waiting' || current.phase === 'ready') {
			current.session.dispose();
			current.ws.close();
		}
	});

	function doLobbyTransition(): void {
		if (current.phase !== 'ready') return;
		if (_showSystem)
			appendMessage({ sender: 'system', text: 'All peers left. Waiting for someone to rejoin\u2026', isSelf: false, senderIndex: 7 });
		current.session.dispose();
		session        = new Session(generateKeypair(), roomId);
		chainsExpected = 0;
		chainsReceived = 0;
		pendingRekey   = true;
		const claim = session.identity.buildClaim(session.ratchetEk, username, roomId, session.epoch);
		ws.send({ type: 'rekey', ek: b64enc(session.ek), ratchetEk: b64enc(session.ratchetEk), claim: b64enc(claim) });
	}

	ws.onMessage = (msg) => {
		if (msg.type === 'rekeyed' && pendingRekey) {
			pendingRekey = false;
			current = { phase: 'waiting', roomId, roomSecret, dns, session, ws, username, peers };
			renderWaiting(_screen, { armoredInvite: makeArmoredInvite(roomId, roomSecret, dns), roomId });
			return;
		}

		if (msg.type === 'peer_joined') {
			if (current.phase !== 'waiting' && current.phase !== 'ready') return;
			const st = current;
			try {
				st.session.identity.acceptClaim(msg.username, b64dec(msg.claim));
			} catch (err) {
				if (_showSystem)
					appendMessage({
						sender: 'system',
						text: `[${msg.username}: identity claim rejected (${err instanceof Error ? err.message : 'invalid'})]`,
						isSelf: false, senderIndex: 7,
					});
				return;
			}
			const peerEk = b64dec(msg.ek);
			const blob   = st.session.wrapChainSeedFor(peerEk, msg.username);
			ws.send({ type: 'relay', to: msg.username, payload: b64enc(blob) });
			st.session.updatePeerRatchetEk(msg.username, b64dec(msg.ratchetEk));
			const fp = st.session.identity.peerFingerprint(msg.username);
			if (!fp) return;
			st.peers.set(msg.username, { ek: msg.ek, ratchetEk: msg.ratchetEk, colorIdx: st.peers.size + 1, fingerprint: fp });
			if (_showSystem)
				appendMessage({ sender: 'system', text: `${msg.username} joined`, isSelf: false, senderIndex: 7 });
			if (current.phase === 'waiting') chainsExpected++;
			return;
		}

		if (msg.type === 'relay') {
			if (current.phase === 'waiting') {
				const st = current;
				st.session.unwrapChainSeed(msg.from, b64dec(msg.payload));
				const peerInfo = st.peers.get(msg.from);
				if (peerInfo) st.session.updatePeerRatchetEk(msg.from, b64dec(peerInfo.ratchetEk));
				chainsReceived++;
				if (chainsReceived >= chainsExpected && chainsExpected > 0) {
					current = { phase: 'ready', roomId, roomSecret, dns, session: st.session, ws, username, peers: st.peers };
					if (!isReconnect)
						renderChat(_screen, {
							username,
							peers: st.peers,
							onSend: doSendMessage,
							onFile: doSendFile,
							onRotate: doRatchetStep,
							getFingerprints: () => ({
								local: st.session.identity.localFingerprint(),
								peers: peerFingerprints(st.peers),
							}),
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
				if (_showSystem)
					appendMessage({
						sender: 'system',
						text: `[${msg.from}: ratchet claim rejected (${err instanceof Error ? err.message : 'invalid'})]`,
						isSelf: false, senderIndex: 7,
					});
				return;
			}
			st.session.receiveRatchetStep(msg.from, b64dec(msg.kemCt), b64dec(msg.encSeed), msg.pn);
			st.session.updatePeerRatchetEk(msg.from, b64dec(msg.newEk));
			const pi = st.peers.get(msg.from);
			if (pi) st.peers.set(msg.from, { ...pi, ratchetEk: msg.newEk });
			const ekClaim = st.session.identity.buildClaim(st.session.ratchetEk, st.username, roomId, st.session.epoch);
			ws.send({ type: 'ek_update', ek: b64enc(st.session.ratchetEk), claim: b64enc(ekClaim) });
			doReceiveMessage(st, msg.from, msg.payload, msg.meta as unknown as MessageEnvelope, msg.sig)
				.catch((err: unknown) => {
					if (_showSystem) {
						const text = err instanceof Error ? err.message : 'decryption failed';
						appendMessage({ sender: 'system', text: `[${msg.from}: ${text}]`, isSelf: false, senderIndex: 7 });
					}
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
						isSelf: false, senderIndex: 7,
					});
				return;
			}
			current.session.updatePeerRatchetEk(msg.from, b64dec(msg.ek));
			const pi = current.peers.get(msg.from);
			if (pi) current.peers.set(msg.from, { ...pi, ratchetEk: msg.ek });
			return;
		}

		if (msg.type === 'broadcast' && current.phase === 'ready') {
			doReceiveMessage(current, msg.from, msg.payload, msg.meta as unknown as MessageEnvelope, msg.sig)
				.catch((err: unknown) => {
					if (_showSystem) {
						const text = err instanceof Error ? err.message : 'decryption failed';
						appendMessage({ sender: 'system', text: `[${msg.from}: ${text}]`, isSelf: false, senderIndex: 7 });
					}
				});
			return;
		}

		if (msg.type === 'peer_left') {
			if (current.phase !== 'ready' && current.phase !== 'waiting') return;
			current.session.removePeer(msg.username);
			current.peers.delete(msg.username);
			if (current.phase === 'ready') {
				if (_showSystem)
					appendMessage({ sender: 'system', text: `${msg.username} left the room`, isSelf: false, senderIndex: 7 });
				if (current.peers.size === 0) doLobbyTransition();
			}
			return;
		}

		if (msg.type === 'error') {
			if (msg.reason === 'username_taken') {
				// dispose and close the ghost connection before going back to landing
				session.dispose();
				ws.close();
				current = { phase: 'landing' };
				renderLanding(_screen, { config: {}, onCreate: doCreate, onJoinClick: (u) => renderJoin(_screen, { username: u, onConnect: (inv) => doJoin(inv, u) }) });
			} else if (_showSystem) {
				appendMessage({ sender: 'system', text: `Server error: ${msg.reason}`, isSelf: false, senderIndex: 7 });
			}
		}
	};

	ws.onClose = () => {
		if (current.phase !== 'ready' && current.phase !== 'waiting') return;
		current.session.dispose();
		if (_showSystem)
			appendMessage({ sender: 'system', text: 'Connection lost. Reconnecting\u2026', isSelf: false, senderIndex: 7 });
		startReconnect(roomId, roomSecret, dns, username);
	};
}

function startReconnect(roomId: string, roomSecret: string, dns: string, username: string): void {
	let delay = 1000;
	const attempt = async () => {
		try {
			const res = await fetch(`${httpUrl(dns)}/health_check`);
			if (res.ok) {
				doJoin({ version: INVITE_VERSION, roomId, roomSecret, dns }, username, true);
				return;
			}
		} catch { /* server not yet reachable */ }
		delay = Math.min(delay * 2, 30000);
		setTimeout(attempt, delay);
	};
	setTimeout(attempt, delay);
}

const AUTO_RATCHET_INTERVAL = 25;

function doSendMessage(text: string): void {
	if (current.phase !== 'ready') return;
	const st = current;
	if (st.session.counter >= AUTO_RATCHET_INTERVAL && st.peers.size > 0) doRatchetStep();
	const bytes = new TextEncoder().encode(text);
	const { ciphertext, counter, epoch } = st.session.sealMessage(bytes);
	const ts   = Date.now();
	const sig  = st.session.identity.signMessage(counter, epoch, st.username, ts, ciphertext);
	const meta: MessageEnvelope = { type: 'message', sender: st.username, counter, epoch, ts };
	st.ws.send({
		type: 'broadcast',
		payload: b64enc(ciphertext),
		meta: meta as unknown as Record<string, unknown>,
		sig: b64enc(sig),
	});
	const idx = st.peers.get(st.username)?.colorIdx ?? 0;
	appendMessage({ sender: st.username, text, isSelf: true, senderIndex: idx });
}

async function doSendFile(filePath: string): Promise<void> {
	if (current.phase !== 'ready') return;
	const st = current;
	if (st.session.counter >= AUTO_RATCHET_INTERVAL && st.peers.size > 0) doRatchetStep();
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
		const ts  = Date.now();
		const sig = st.session.identity.signMessage(counter, epoch, st.username, ts, ciphertext);
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
		appendFile({ sender: st.username, filename, size, mime, isSelf: true, senderIndex: idx });
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
	const sig        = b64dec(sigBase64);
	const ok = state.session.identity.verifyMessage(
		from, meta.counter, meta.epoch ?? 0, meta.sender, meta.ts, ciphertext, sig,
	);
	if (!ok) throw new Error('message signature verification failed');
	const senderIdx = colorIdxFor(from, state.peers);

	if (meta.type === 'message') {
		const plain = state.session.openMessage(from, meta.epoch ?? 0, meta.counter, ciphertext);
		appendMessage({
			sender: from,
			text: new TextDecoder().decode(plain),
			isSelf: false,
			senderIndex: senderIdx,
		});
	} else if (meta.type === 'file') {
		const h = state.session.openFileKey(from, meta.epoch ?? 0, meta.counter);
		let pool: SealStreamPool | null = null;
		let settled = false;
		try {
			pool = await SealStreamPool.create(XChaCha20CipherBun, h.key, { wasm: chacha20Wasm });
			const plain = await pool.open(ciphertext);
			h.commit();
			settled = true;
			const outPath = resolveUniqueFilename(join(process.cwd(), meta.filename ?? 'attachment'));
			await Bun.write(outPath, plain);
			appendFile({
				sender: from,
				filename: meta.filename ?? 'file',
				size: meta.size ?? plain.length,
				mime: meta.mime ?? 'application/octet-stream',
				isSelf: false,
				senderIndex: senderIdx,
				saved: outPath,
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
	const payloads: Record<string, { kemCt: string; encSeed: string; pn: number }> = {};
	for (const [peerUsername] of st.peers) {
		const { kemCt, encSeed, pn } = st.session.performRatchetStep(peerUsername);
		payloads[peerUsername] = { kemCt: b64enc(kemCt), encSeed: b64enc(encSeed), pn };
	}
	st.session.commitRatchetStep();
	appendMessage({ sender: st.username, text: '[\uD83D\uDD12 keys rotated]', isSelf: true, senderIndex: 0 });
	const bytes = new TextEncoder().encode('[\uD83D\uDD12 keys rotated]');
	const { ciphertext, counter, epoch } = st.session.sealMessage(bytes);
	const ts    = Date.now();
	const sig   = st.session.identity.signMessage(counter, epoch, st.username, ts, ciphertext);
	const claim = st.session.identity.buildClaim(st.session.ratchetEk, st.username, st.session.roomId, epoch);
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
