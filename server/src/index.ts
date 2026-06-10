import type { ConnData, Room } from './rooms.ts';
import {
	handleBroadcast,
	handleClose,
	handleCreate,
	handleIdentify,
	handleJoin,
	handleRekey,
	handleRelay,
	handleRatchetStep,
	handleEkUpdate,
} from './relay.ts';
import type { InboundMsg } from './types.ts';
import { parseFlags } from './flags.ts';

function parseMaxRoomSize(): number {
	const raw = parseInt(process.env.MAX_ROOM_SIZE ?? '20', 10);
	return isNaN(raw) || raw < 0 ? 20 : raw;
}

export interface ServerConfig {
	port?:        number
	maxRoomSize?: number
	adminToken?:  string | undefined
	hostname?:    string
	roomTtl?:     number
}

export function startServer(config: ServerConfig = {}) {
	const port        = config.port ?? parseInt(process.env.PORT ?? '1337', 10);
	const maxRoomSize = config.maxRoomSize ?? parseMaxRoomSize();
	const adminToken  = 'adminToken' in config ? config.adminToken : process.env.ADMIN_TOKEN;
	// Bind explicit IPv4 loopback, never the "localhost" name. Resolving
	// "localhost" yields both 127.0.0.1 and ::1, and Bun.serve binds only the
	// first the resolver returns (::1 on hosts with IPv6); callers reaching the
	// broker over 127.0.0.1 then hit a closed port. Caddy proxies to 127.0.0.1,
	// so the relay stays loopback-only by default. Set HOST=0.0.0.0 to expose it
	// directly (e.g. behind a different reverse proxy on another host).
	const hostname    = config.hostname ?? process.env.HOST ?? '127.0.0.1';
	const rooms       = new Map<string, Room>();

	const ROOM_TTL_HOURS = config.roomTtl ?? parseInt(process.env.ROOM_TTL ?? '24', 10);
	const ROOM_TTL_MS    = (isNaN(ROOM_TTL_HOURS) || ROOM_TTL_HOURS <= 0)
		? 0
		: ROOM_TTL_HOURS * 60 * 60 * 1000;

	function pruneRooms(): void {
		if (ROOM_TTL_MS === 0) return;
		const now = Date.now();
		for (const [id, room] of rooms)
			if (room.conns.size === 0 && now - room.lastActivity > ROOM_TTL_MS)
				rooms.delete(id);
	}

	pruneRooms();
	Bun.cron('@hourly', pruneRooms);

	const srv = Bun.serve<ConnData>({
		hostname,
		port,
		fetch(req, server) {
			const url = new URL(req.url);
			if (url.pathname === '/health_check')
				return new Response('OK', { status: 200, headers: { 'Access-Control-Allow-Origin': '*' } });
			if (url.pathname === '/ws') {
				const data: ConnData = { roomId: null, username: null, ek: null, ratchetEk: null, claim: null };
				if (server.upgrade(req, { data })) return undefined;
				return new Response('Upgrade failed', { status: 500 });
			}
			return new Response('Not found', { status: 404 });
		},
		websocket: {
			open(_ws) { /* Bun requires the handler; identity is set later via identify */ },
			message(ws, raw) {
				try {
					const msg = JSON.parse(raw as string) as InboundMsg;
					switch (msg.type) {
					case 'create':
						handleCreate(ws, msg, rooms, maxRoomSize, adminToken);
						break;
					case 'join':
						handleJoin(ws, msg, rooms);
						break;
					case 'identify':
						handleIdentify(ws, msg, rooms);
						break;
					case 'relay':
						handleRelay(ws, msg, rooms);
						break;
					case 'broadcast':
						handleBroadcast(ws, msg, rooms);
						break;
					case 'ratchet_step':
						handleRatchetStep(ws, msg, rooms);
						break;
					case 'ek_update':
						handleEkUpdate(ws, msg, rooms);
						break;
					case 'rekey':
						handleRekey(ws, msg, rooms);
						break;
					}
				} catch { /* untrusted input: a bad frame must not crash or leak; just drop it */ }
			},
			close(ws) {
				handleClose(ws, rooms);
			},
		},
	});

	return srv;
}

if (import.meta.main) {
	const { config, help, error } = parseFlags(process.argv.slice(2));
	if (help) {
		console.log(help);
		process.exit(0);
	}
	if (error) {
		console.error(error);
		process.exit(1);
	}
	const server = startServer(config);
	console.log(`Leviathan server listening on ${server.hostname}:${server.port}`);
}
