import type { ServerWebSocket } from 'bun';
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
	if (adminToken !== undefined && adminToken !== '' && msg.adminToken !== adminToken) {
		send(ws, { type: 'error', reason: 'forbidden' });
		return;
	}
	const id   = createRoom(rooms, maxRoomSize);
	const room = rooms.get(id);
	if (!room) throw new Error('room not found');
	send(ws, { type: 'room_created', roomId: id, roomSecret: room.roomSecret });
}

export function handleJoin(
	ws:    ServerWebSocket<ConnData>,
	msg:   JoinMsg,
	rooms: Map<string, Room>,
): void {
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
		if (conn !== ws && conn.data.username && conn.data.ek && conn.data.ratchetEk)
			members.push({ username: conn.data.username, ek: conn.data.ek, ratchetEk: conn.data.ratchetEk });
	}
	send(ws, { type: 'joined', members });
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
	if (msg.ek.length !== 1580)                {
		ws.close(); return;
	}
	if (msg.ratchetEk.length !== 1580)         {
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
	for (const conn of room.conns) {
		if (conn !== ws)
			send(conn, {
				type: 'peer_joined',
				username: uname,
				ek: msg.ek,
				ratchetEk: msg.ratchetEk,
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
	const room = getRoom(rooms, ws.data.roomId);
	if (!room) return;
	room.lastActivity    = Date.now();
	ws.data.ratchetEk    = msg.newEk;   // keep ConnData current for late joiners
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
	const room = getRoom(rooms, ws.data.roomId);
	if (!room) return;
	room.lastActivity = Date.now();
	ws.data.ratchetEk = msg.ek;   // keep ConnData current for late joiners
	for (const conn of room.conns) {
		if (conn !== ws)
			send(conn, { type: 'ek_update_fwd', from: ws.data.username, ek: msg.ek });
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
	const room = getRoom(rooms, ws.data.roomId);
	if (!room) return;
	ws.data.ek        = msg.ek;
	ws.data.ratchetEk = msg.ratchetEk;
	room.lastActivity = Date.now();
	send(ws, { type: 'rekeyed' });
}
