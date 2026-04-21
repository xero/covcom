import {
	chacha20Wasm,
	generateKeypair,
	Session,
	serializeInvite,
	armorInvite,
	INVITE_VERSION,
	SealStreamPool,
	XChaCha20Cipher,
	wipe,
} from '@covcom/lib';
import type { InvitePayload, MessageEnvelope } from '@covcom/lib';
import { WS } from './ws.js';
import { renderLanding } from './views/landing.js';
import { renderWaiting } from './views/waiting.js';
import { renderJoin } from './views/join.js';
import { renderChat, appendMessage, appendFile, showLobbyBar, hideLobbyBar } from './views/chat.js';

interface PeerInfo {
	ek:        string
	ratchetEk: string
	colorIdx:  number
}

type AppState =
	| { phase: 'landing' }
	| {
		phase:      'joining'
		roomId:     string
		roomSecret: string
		dns:        string
		username:   string
	  }
	| {
		phase:      'waiting'
		roomId:     string
		roomSecret: string
		dns:        string
		session:    Session
		ws:         WS
		username:   string
		peers:      Map<string, PeerInfo>
	  }
	| {
		phase:      'ready'
		roomId:     string
		roomSecret: string
		dns:        string
		session:    Session
		ws:         WS
		username:   string
		peers:      Map<string, PeerInfo>
	  }

let current: AppState = { phase: 'landing' };
let appRoot: Element;

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
	const host  = server.split(':')[0];
	const local = host === 'localhost' || host.startsWith('127.');
	return `${local ? 'ws' : 'wss'}://${server}/ws`;
}

function makeArmoredInvite(roomId: string, roomSecret: string, dns?: string): string {
	return armorInvite(serializeInvite({ version: INVITE_VERSION, roomId, roomSecret, dns }));
}

function httpUrl(server: string): string {
	const host  = server.split(':')[0];
	const local = host === 'localhost' || host.startsWith('127.');
	return `${local ? 'http' : 'https'}://${server}`;
}

export function mount(root: Element): void {
	appRoot = root;
	window.addEventListener('beforeunload', () => {
		if (current.phase === 'waiting' || current.phase === 'ready') {
			current.session.dispose();
			current.ws.close();
		}
	});
	renderLanding(root, {
		onCreate: doCreate,
		onJoinClick: (username) => {
			renderJoin(appRoot, {
				username,
				onConnect: (invite) => doJoin(invite, username),
			});
		},
	});
}

export function doCreate(server: string, username: string, adminToken?: string): void {
	const ws  = new WS(wsUrl(server));
	const dns = server;
	let roomId     = '';
	let roomSecret = '';

	ws.onOpen = () => ws.send({ type: 'create', adminToken });

	ws.onMessage = (msg) => {
		if (msg.type === 'room_created') {
			roomId     = msg.roomId;
			roomSecret = msg.roomSecret;
			current    = { phase: 'joining', roomId, roomSecret, dns, username };
			ws.send({ type: 'join', roomId, roomSecret });
		} else if (msg.type === 'joined') {
			doConnect(ws, roomId, roomSecret, dns, username, msg.members);
		} else if (msg.type === 'error') {
			alert(`Server error: ${msg.reason}`);
		}
	};

	ws.onClose = () => {
		if (current.phase === 'joining' || current.phase === 'landing') {
			alert('Connection failed. Is the server running?');
		}
	};
}

export function doJoin(invite: InvitePayload, username: string, isReconnect = false): void {
	const dns = invite.dns ?? 'localhost:3000';
	const ws  = new WS(wsUrl(dns));
	current   = { phase: 'joining', roomId: invite.roomId, roomSecret: invite.roomSecret, dns, username };

	ws.onOpen = () => ws.send({ type: 'join', roomId: invite.roomId, roomSecret: invite.roomSecret });

	ws.onMessage = (msg) => {
		if (msg.type === 'joined') {
			doConnect(ws, invite.roomId, invite.roomSecret, dns, username, msg.members, isReconnect);
		} else if (msg.type === 'error') {
			if (msg.reason === 'username_taken') {
				current = { phase: 'landing' };
				renderLanding(appRoot, { onCreate: doCreate, onJoinClick: (u) => renderJoin(appRoot, { username: u, onConnect: (inv) => doJoin(inv, u) }) });
			} else {
				alert(`Server error: ${msg.reason}`);
			}
		}
	};

	ws.onClose = () => {
		if (current.phase === 'joining') {
			alert('Connection failed. Is the server running?');
		}
	};
}

function doConnect(
	ws:          WS,
	roomId:      string,
	roomSecret:  string,
	dns:         string,
	username:    string,
	members:     { username: string; ek: string; ratchetEk: string }[],
	isReconnect  = false,
): void {
	let session  = new Session(generateKeypair(), roomId);
	const peers  = new Map<string, PeerInfo>();
	let chainsExpected = 0;
	let chainsReceived = 0;
	let pendingRekey   = false;
	let situationThree = false;

	ws.send({ type: 'identify', username, ek: b64enc(session.ek), ratchetEk: b64enc(session.ratchetEk) });

	for (const m of members) {
		const blob = session.wrapChainSeedFor(b64dec(m.ek), m.username);
		ws.send({ type: 'relay', to: m.username, payload: b64enc(blob) });
		peers.set(m.username, { ek: m.ek, ratchetEk: m.ratchetEk, colorIdx: peers.size + 1 });
		session.updatePeerRatchetEk(m.username, b64dec(m.ratchetEk));
		chainsExpected++;
	}

	current = { phase: 'waiting', roomId, roomSecret, dns, session, ws, username, peers };
	if (members.length === 0) {
		if (isReconnect) {
			// room is empty after reconnect — show lobby overlay over existing history
			situationThree = true;
			showLobbyBar(makeArmoredInvite(roomId, roomSecret, dns), roomId);
		} else {
			renderWaiting(appRoot, { armoredInvite: makeArmoredInvite(roomId, roomSecret, dns), roomId, username });
		}
	}

	function doLobbyTransition(): void {
		if (current.phase !== 'ready') return;
		current.session.dispose();
		session        = new Session(generateKeypair(), roomId);
		chainsExpected = 0;
		chainsReceived = 0;
		situationThree = true;
		pendingRekey   = true;
		ws.send({ type: 'rekey', ek: b64enc(session.ek), ratchetEk: b64enc(session.ratchetEk) });
	}

	ws.onMessage = (msg) => {
		if (msg.type === 'rekeyed' && pendingRekey) {
			pendingRekey = false;
			current = { phase: 'waiting', roomId, roomSecret, dns, session, ws, username, peers };
			showLobbyBar(makeArmoredInvite(roomId, roomSecret, dns), roomId);
			return;
		}

		if (msg.type === 'peer_joined') {
			if (current.phase !== 'waiting' && current.phase !== 'ready') return;
			const st     = current;
			const peerEk = b64dec(msg.ek);
			const blob   = st.session.wrapChainSeedFor(peerEk, msg.username);
			ws.send({ type: 'relay', to: msg.username, payload: b64enc(blob) });
			st.session.updatePeerRatchetEk(msg.username, b64dec(msg.ratchetEk));
			st.peers.set(msg.username, { ek: msg.ek, ratchetEk: msg.ratchetEk, colorIdx: st.peers.size + 1 });
			appendMessage({ sender: 'system', text: `${msg.username} joined`, isSelf: false, className: 'system' });
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
					if (situationThree) {
						situationThree = false;
						hideLobbyBar();
					} else if (!isReconnect) {
						renderChat(appRoot, { username, peers: st.peers, onSend: doSendMessage, onFile: doSendFile, onRotate: doRatchetStep });
					}
					doRatchetStep();
				}
			} else if (current.phase === 'ready') {
				current.session.unwrapChainSeed(msg.from, b64dec(msg.payload));
			}
			return;
		}

		if (msg.type === 'ratchet_step_fwd' && current.phase === 'ready') {
			const st = current;
			st.session.receiveRatchetStep(msg.from, b64dec(msg.kemCt), b64dec(msg.encSeed), msg.pn);
			st.session.updatePeerRatchetEk(msg.from, b64dec(msg.newEk));
			const pi = st.peers.get(msg.from);
			if (pi) st.peers.set(msg.from, { ...pi, ratchetEk: msg.newEk });
			ws.send({ type: 'ek_update', ek: b64enc(st.session.ratchetEk) });
			doReceiveMessage(st, msg.from, msg.payload, msg.meta as unknown as MessageEnvelope)
				.catch((err: unknown) => {
					appendMessage({ sender: 'system', text: `[${msg.from}: ${err instanceof Error ? err.message : 'decryption failed'}]`, isSelf: false, className: 'system' });
				});
			return;
		}

		if (msg.type === 'ek_update_fwd') {
			if (current.phase !== 'ready' && current.phase !== 'waiting') return;
			current.session.updatePeerRatchetEk(msg.from, b64dec(msg.ek));
			const pi = current.peers.get(msg.from);
			if (pi) current.peers.set(msg.from, { ...pi, ratchetEk: msg.ek });
			return;
		}

		if (msg.type === 'broadcast' && current.phase === 'ready') {
			doReceiveMessage(current, msg.from, msg.payload, msg.meta as unknown as MessageEnvelope)
				.catch((err: unknown) => {
					appendMessage({ sender: 'system', text: `[${msg.from}: ${err instanceof Error ? err.message : 'decryption failed'}]`, isSelf: false, className: 'system' });
				});
			return;
		}

		if (msg.type === 'peer_left') {
			if (current.phase !== 'ready' && current.phase !== 'waiting') return;
			current.session.removePeer(msg.username);
			current.peers.delete(msg.username);
			if (current.phase === 'ready') {
				appendMessage({ sender: 'system', text: `${msg.username} left the room`, isSelf: false, className: 'system' });
				if (current.peers.size === 0) doLobbyTransition();
			}
			return;
		}

		if (msg.type === 'error') {
			if (msg.reason === 'username_taken') {
				// username claimed while offline — dispose and close the ghost connection
				// before navigating away; otherwise it stays in room.conns and double-
				// processes every subsequent message on the shared session
				session.dispose();
				ws.close();
				current = { phase: 'landing' };
				renderLanding(appRoot, { onCreate: doCreate, onJoinClick: (u) => renderJoin(appRoot, { username: u, onConnect: (inv) => doJoin(inv, u) }) });
			} else {
				alert(`Server error: ${msg.reason}`);
			}
		}
	};

	ws.onClose = () => {
		if (current.phase !== 'ready' && current.phase !== 'waiting') return;
		current.session.dispose();
		appendMessage({ sender: 'system', text: 'Connection lost. Reconnecting\u2026', isSelf: false, className: 'system' });
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
	const meta: MessageEnvelope = { type: 'message', sender: st.username, counter, epoch, ts: Date.now() };
	st.ws.send({ type: 'broadcast', payload: b64enc(ciphertext), meta: meta as unknown as Record<string, unknown> });
	appendMessage({ sender: st.username, text, isSelf: true });
}

async function doSendFile(file: File): Promise<void> {
	if (current.phase !== 'ready') return;
	const st = current;
	if (st.session.counter >= AUTO_RATCHET_INTERVAL && st.peers.size > 0) doRatchetStep();
	const bytes = new Uint8Array(await file.arrayBuffer());
	const { msgKey, counter, epoch } = st.session.sealFileKey();
	let pool: SealStreamPool | null = null;
	try {
		pool = await SealStreamPool.create(XChaCha20Cipher, msgKey, {
			wasm: chacha20Wasm,
			workers: navigator.hardwareConcurrency ?? 4,
			chunkSize: 65536,
		});
		const ciphertext = await pool.seal(bytes);
		const mime = file.type || 'application/octet-stream';
		const meta: MessageEnvelope = { type: 'file', sender: st.username, counter, epoch, ts: Date.now(), filename: file.name, size: file.size, mime };
		st.ws.send({ type: 'broadcast', payload: b64enc(ciphertext), meta: meta as unknown as Record<string, unknown> });
		appendFile({ sender: st.username, filename: file.name, size: file.size, mime, isSelf: true }, bytes);
	} catch (err) {
		appendMessage({ sender: 'system', text: `Send failed: ${err instanceof Error ? err.message : String(err)}`, isSelf: false, className: 'system' });
	} finally {
		pool?.destroy();
		wipe(msgKey);
	}
}

async function doReceiveMessage(
	state: AppState & { phase: 'ready' },
	from: string,
	payloadBase64: string,
	meta: MessageEnvelope,
): Promise<void> {
	const ciphertext = b64dec(payloadBase64);
	if (meta.type === 'message') {
		const plain = state.session.openMessage(from, meta.epoch ?? 0, meta.counter, ciphertext);
		appendMessage({ sender: from, text: new TextDecoder().decode(plain), isSelf: false });
	} else if (meta.type === 'file') {
		const h = state.session.openFileKey(from, meta.epoch ?? 0, meta.counter);
		let pool: SealStreamPool | null = null;
		let settled = false;
		try {
			pool = await SealStreamPool.create(XChaCha20Cipher, h.key, { wasm: chacha20Wasm });
			const plain = await pool.open(ciphertext);
			h.commit();
			settled = true;
			appendFile({ sender: from, filename: meta.filename ?? 'file', size: meta.size ?? plain.length, mime: meta.mime ?? 'application/octet-stream', isSelf: false }, plain);
		} catch (err) {
			if (!settled) h.rollback();
			appendMessage({ sender: 'system', text: `File receive failed: ${err instanceof Error ? err.message : String(err)}`, isSelf: false, className: 'system' });
		} finally {
			pool?.destroy();
		}
	}
}

function doRatchetStep(): void {
	if (current.phase !== 'ready') return;
	if (current.peers.size === 0) return;
	const st      = current;
	const payloads: Record<string, { kemCt: string; encSeed: string; pn: number }> = {};
	for (const [peerUsername] of st.peers) {
		const { kemCt, encSeed, pn } = st.session.performRatchetStep(peerUsername);
		payloads[peerUsername] = { kemCt: b64enc(kemCt), encSeed: b64enc(encSeed), pn };
	}
	st.session.commitRatchetStep();
	appendMessage({ sender: st.username, text: '[\uD83D\uDD12 keys rotated]', isSelf: true, className: 'ratchet-self' });
	const bytes = new TextEncoder().encode('[\uD83D\uDD12 keys rotated]');
	const { ciphertext, counter, epoch } = st.session.sealMessage(bytes);
	const meta: MessageEnvelope = {
		type: 'message', sender: st.username,
		counter, epoch, ts: Date.now(),
	};
	st.ws.send({
		type: 'ratchet_step',
		payloads,
		newEk: b64enc(st.session.ratchetEk),
		payload: b64enc(ciphertext),
		meta: meta as unknown as Record<string, unknown>,
	});
}
