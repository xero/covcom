import type { ServerWebSocket } from 'bun';
import { PROTOCOL_VERSION, hasUnsafeFormatChars } from '@covcom/lib';
import { createRoom, getRoom } from './rooms.ts';
import type { ConnData, Room } from './rooms.ts';
import type {
	BroadcastMsg,
	CreateMsg,
	EkUpdateMsg,
	IdentifyMsg,
	JoinMsg,
	OutboundMsg,
	RatchetStepMsg,
	RekeyMsg,
	RelayMsg,
} from './types.ts';

function send(ws: ServerWebSocket<ConnData>, msg: OutboundMsg): void {
	ws.send(JSON.stringify(msg));
}

export function handleCreate(
	ws:          ServerWebSocket<ConnData>,
	msg:         CreateMsg,
	rooms:       Map<string, Room>,
	maxRoomSize: number,
	adminToken:  string | undefined,
): void {
	// Compatibility gate, not a security boundary: absent field means a pre-v3
	// client, which mismatches and is rejected before any room work.
	if (msg.protocolVersion !== PROTOCOL_VERSION) {
		send(ws, { type: 'error', reason: 'version_mismatch', serverVersion: PROTOCOL_VERSION });
		ws.close();
		return;
	}
	if (adminToken !== undefined && adminToken !== '' && msg.adminToken !== adminToken) {
		send(ws, { type: 'error', reason: 'forbidden' });
		return;
	}
	const id   = createRoom(rooms, maxRoomSize);
	const room = rooms.get(id);
	if (!room) throw new Error('room not found');
	send(ws, { type: 'room_created', roomId: id, roomSecret: room.roomSecret, serverVersion: PROTOCOL_VERSION });
}

export function handleJoin(
	ws:    ServerWebSocket<ConnData>,
	msg:   JoinMsg,
	rooms: Map<string, Room>,
): void {
	if (msg.protocolVersion !== PROTOCOL_VERSION) {
		send(ws, { type: 'error', reason: 'version_mismatch', serverVersion: PROTOCOL_VERSION });
		ws.close();
		return;
	}
	if (ws.data.roomId) {
		send(ws, { type: 'error', reason: 'forbidden' }); return;
	}
	const room = getRoom(rooms, msg.roomId);
	if (!room) {
		send(ws, { type: 'error', reason: 'not_found' }); return;
	}
	if (msg.roomSecret !== room.roomSecret) {
		send(ws, { type: 'error', reason: 'forbidden' });
		return;
	}
	if (room.maxSize > 0 && room.conns.size >= room.maxSize) {
		send(ws, { type: 'error', reason: 'room_full' });
		return;
	}
	room.conns.add(ws);
	ws.data.roomId    = msg.roomId;
	room.lastActivity = Date.now();

	const members = [];
	for (const conn of room.conns) {
		if (conn !== ws && conn.data.username && conn.data.ek && conn.data.ratchetEk && conn.data.claim)
			members.push({
				username: conn.data.username,
				ek: conn.data.ek,
				ratchetEk: conn.data.ratchetEk,
				claim: conn.data.claim,
			});
	}
	send(ws, { type: 'joined', members, serverVersion: PROTOCOL_VERSION });
}

export function handleIdentify(
	ws: ServerWebSocket<ConnData>,
	msg: IdentifyMsg,
	rooms: Map<string, Room>,
): void {
	if (!ws.data.roomId) return;
	const uname = msg.username.trim();
	if (!uname || uname.length > 64)           {
		ws.close(); return;
	}
	// Reject (never strip) control chars: a stripped name would desync from the
	// signed identity claim and fail peer verification. Closing matches the
	// other reject-on-invalid checks here, so no new error reason is introduced.
	// Deliberate hardening beyond PROTOCOL.md, which states no charset rules.
	// eslint-disable-next-line no-control-regex -- forbidding C0/C1 + DEL is the point
	if (/[\x00-\x1F\x7F-\x9F]/.test(uname))    {
		ws.close(); return;
	}
	// Reject (never strip) bidi controls + zero-width format chars too: they
	// enable display-name spoofing (text reordering / homoglyph handles)
	// without being C0/C1. Same reject-don't-strip rationale as the control-char
	// check above (keeps the handle bound to the signed claim). Shares @covcom/lib's
	// code-point list via hasUnsafeFormatChars so the relay and client sanitizer
	// can't drift.
	if (hasUnsafeFormatChars(uname)) {
		ws.close(); return;
	}
	if (msg.ek.length !== 1580)                {
		ws.close(); return;
	}
	if (msg.ratchetEk.length !== 1580)         {
		ws.close(); return;
	}
	if (!msg.claim || msg.claim.length === 0 || msg.claim.length > 4000) {
		ws.close(); return;
	}
	const room = getRoom(rooms, ws.data.roomId);
	if (!room) return;
	room.lastActivity = Date.now();
	for (const conn of room.conns) {
		if (conn !== ws && conn.data.username === uname) {
			send(ws, { type: 'error', reason: 'username_taken' });
			return;
		}
	}
	ws.data.username  = uname;
	ws.data.ek        = msg.ek;
	ws.data.ratchetEk = msg.ratchetEk;
	ws.data.claim     = msg.claim;
	for (const conn of room.conns) {
		if (conn !== ws)
			send(conn, {
				type: 'peer_joined',
				username: uname,
				ek: msg.ek,
				ratchetEk: msg.ratchetEk,
				claim: msg.claim,
			});
	}
}

export function handleRatchetStep(
	ws: ServerWebSocket<ConnData>,
	msg: RatchetStepMsg,
	rooms: Map<string, Room>,
): void {
	if (!ws.data.roomId) return;
	if (!ws.data.username) return;
	if (msg.newEk.length !== 1580) return;
	if (!msg.claim || msg.claim.length === 0 || msg.claim.length > 4000) return;
	if (!msg.sig || msg.sig.length === 0 || msg.sig.length > 200) return;
	const room = getRoom(rooms, ws.data.roomId);
	if (!room) return;
	room.lastActivity    = Date.now();
	ws.data.ratchetEk    = msg.newEk;   // keep ConnData current for late joiners
	ws.data.claim        = msg.claim;   // refresh stored claim for late joiners
	const from = ws.data.username;
	for (const conn of room.conns) {
		if (conn === ws) continue;
		const username = conn.data.username;
		if (!username) continue;
		const peer = msg.payloads[username];
		if (!peer) continue;
		send(conn, {
			type: 'ratchet_step_fwd',
			from,
			kemCt: peer.kemCt,
			encSeed: peer.encSeed,
			pn: peer.pn,
			newEk: msg.newEk,
			payload: msg.payload,
			meta: msg.meta,
			sig: msg.sig,
			claim: msg.claim,
		});
	}
}

export function handleEkUpdate(
	ws: ServerWebSocket<ConnData>,
	msg: EkUpdateMsg,
	rooms: Map<string, Room>,
): void {
	if (!ws.data.roomId) return;
	if (!ws.data.username) return;
	if (!msg.claim || msg.claim.length === 0 || msg.claim.length > 4000) return;
	const room = getRoom(rooms, ws.data.roomId);
	if (!room) return;
	room.lastActivity = Date.now();
	ws.data.ratchetEk = msg.ek;       // keep ConnData current for late joiners
	ws.data.claim     = msg.claim;    // refresh stored claim
	for (const conn of room.conns) {
		if (conn !== ws)
			send(conn, { type: 'ek_update_fwd', from: ws.data.username, ek: msg.ek, claim: msg.claim });
	}
}

export function handleRelay(
	ws: ServerWebSocket<ConnData>,
	msg: RelayMsg,
	rooms: Map<string, Room>,
): void {
	if (!ws.data.roomId) return;
	if (!ws.data.username) return;
	const room = getRoom(rooms, ws.data.roomId);
	if (!room) return;
	room.lastActivity = Date.now();
	for (const conn of room.conns) {
		if (conn.data.username === msg.to) {
			send(conn, { type: 'relay', from: ws.data.username, payload: msg.payload });
			return;
		}
	}
}

export function handleBroadcast(
	ws: ServerWebSocket<ConnData>,
	msg: BroadcastMsg,
	rooms: Map<string, Room>,
): void {
	if (!ws.data.roomId) return;
	if (!ws.data.username) return;
	if (!msg.sig || msg.sig.length === 0 || msg.sig.length > 200) return;
	const room = getRoom(rooms, ws.data.roomId);
	if (!room) return;
	room.lastActivity = Date.now();
	for (const conn of room.conns) {
		if (conn !== ws) {
			send(conn, {
				type: 'broadcast',
				from: ws.data.username,
				payload: msg.payload,
				meta: msg.meta,
				sig: msg.sig,
			});
		}
	}
}

export function handleClose(
	ws: ServerWebSocket<ConnData>,
	rooms: Map<string, Room>,
): void {
	if (!ws.data.roomId) return;
	const room = getRoom(rooms, ws.data.roomId);
	if (!room) return;
	room.conns.delete(ws);
	if (ws.data.username) {
		for (const conn of room.conns)
			send(conn, { type: 'peer_left', username: ws.data.username });
	}
}

export function handleRekey(
	ws:    ServerWebSocket<ConnData>,
	msg:   RekeyMsg,
	rooms: Map<string, Room>,
): void {
	if (!ws.data.username) return;
	if (!ws.data.roomId) return;
	if (!msg.claim || msg.claim.length === 0 || msg.claim.length > 4000) return;
	const room = getRoom(rooms, ws.data.roomId);
	if (!room) return;
	ws.data.ek        = msg.ek;
	ws.data.ratchetEk = msg.ratchetEk;
	ws.data.claim     = msg.claim;    // refresh so late joiners see the new identity
	room.lastActivity = Date.now();
	send(ws, { type: 'rekeyed' });
}
