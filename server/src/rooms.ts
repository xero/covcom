import type { ServerWebSocket } from 'bun';

export interface ConnData {
	roomId:    string | null
	username:  string | null
	ek:        string | null
	ratchetEk: string | null
	claim:     string | null  // last-known identity claim for late-joiner replay
}

export interface Room {
	id:           string
	conns:        Set<ServerWebSocket<ConnData>>
	maxSize:      number
	roomSecret:   string
	lastActivity: number
}

export function createRoom(rooms: Map<string, Room>, maxSize: number): string {
	const idBytes = new Uint8Array(16);
	crypto.getRandomValues(idBytes);
	const id = Array.from(idBytes).map(b => b.toString(16).padStart(2, '0')).join('');

	const secretBytes = new Uint8Array(16);
	crypto.getRandomValues(secretBytes);
	let s = '';
	for (const b of secretBytes) s += String.fromCharCode(b);
	const roomSecret = btoa(s);

	rooms.set(id, { id, conns: new Set(), maxSize, roomSecret, lastActivity: Date.now() });
	return id;
}

export function deleteRoom(rooms: Map<string, Room>, id: string): void {
	rooms.delete(id);
}

export function getRoom(rooms: Map<string, Room>, id: string): Room | undefined {
	return rooms.get(id);
}
