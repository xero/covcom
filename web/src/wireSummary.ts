import type { InboundMsg, OutboundMsg } from './wireTypes.js';
import { b, code } from './rich.js';
import type { RichText } from './rich.js';

// Lifted verbatim from eventLog.ts (summarize + the redact/flatten helpers they
// depend on). Summaries are RichText token arrays; user-controlled fields are
// carried as tokens (b()/code()) and rendered via textContent, never as HTML.

export function redact(b64: string | undefined | null): string {
	if (!b64) return '∅';
	const head = b64.slice(0, 8);
	const pad  = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
	const len  = Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
	return `${len}B "${head}…"`;
}

export function summarizeInbound(msg: InboundMsg): { summary: RichText; details: Record<string, string | number | boolean> } {
	switch (msg.type) {
	case 'room_created':
		return { summary: ['room created ', code(msg.roomId)],
			details: { roomId: msg.roomId, roomSecret: redact(msg.roomSecret) } };
	case 'joined':
		return { summary: `joined room (${msg.members.length} existing member${msg.members.length === 1 ? '' : 's'})`,
			details: {
				members: msg.members.length,
				usernames: msg.members.map(m => m.username).join(', ') || '∅',
				memberEks: msg.members.map(m => redact(m.ek)).join(' | ') || '∅',
				memberClaims: msg.members.map(m => redact(m.claim)).join(' | ') || '∅',
			} };
	case 'peer_joined':
		return { summary: [b(msg.username), ' joined'],
			details: { username: msg.username, ek: redact(msg.ek), ratchetEk: redact(msg.ratchetEk), claim: redact(msg.claim) } };
	case 'peer_left':
		return { summary: [b(msg.username), ' left'],
			details: { username: msg.username } };
	case 'relay':
		return { summary: ['relay ', b(msg.from), ' → self'],
			details: { from: msg.from, payload: redact(msg.payload) } };
	case 'broadcast': {
		const meta = msg.meta as Record<string, unknown>;
		return { summary: [b(msg.from), ` broadcast (${String(meta?.type ?? 'msg')})`],
			details: {
				from: msg.from,
				payload: redact(msg.payload),
				sig: redact(msg.sig),
				...flattenMeta(meta),
			} };
	}
	case 'ratchet_step_fwd':
		return { summary: [b(msg.from), ' ratchet step'],
			details: {
				from: msg.from,
				pn: msg.pn,
				kemCt: redact(msg.kemCt),
				encSeed: redact(msg.encSeed),
				newEk: redact(msg.newEk),
				payload: redact(msg.payload),
				sig: redact(msg.sig),
				claim: redact(msg.claim),
				...flattenMeta(msg.meta as Record<string, unknown>),
			} };
	case 'ek_update_fwd':
		return { summary: [b(msg.from), ' ek update'],
			details: { from: msg.from, ek: redact(msg.ek), claim: redact(msg.claim) } };
	case 'rekeyed':
		return { summary: 'server confirmed rekey', details: {} };
	case 'error':
		return { summary: `server error: ${msg.reason}`, details: { reason: msg.reason } };
	default: {
		const t = (msg as { type: string }).type;
		return { summary: `unknown inbound: ${t}`, details: { type: t } };
	}
	}
}

export function summarizeOutbound(msg: OutboundMsg): { summary: RichText; details: Record<string, string | number | boolean> } {
	switch (msg.type) {
	case 'create':
		return { summary: 'create room', details: { adminToken: msg.adminToken ? '✓' : '∅' } };
	case 'join':
		return { summary: ['join ', code(msg.roomId)],
			details: { roomId: msg.roomId, roomSecret: redact(msg.roomSecret) } };
	case 'identify':
		return { summary: ['identify as ', b(msg.username)],
			details: { username: msg.username, ek: redact(msg.ek), ratchetEk: redact(msg.ratchetEk), claim: redact(msg.claim) } };
	case 'relay':
		return { summary: ['relay self → ', b(msg.to)],
			details: { to: msg.to, payload: redact(msg.payload) } };
	case 'broadcast': {
		const meta = msg.meta as Record<string, unknown>;
		return { summary: `broadcast (${String(meta?.type ?? 'msg')})`,
			details: { payload: redact(msg.payload), sig: redact(msg.sig), ...flattenMeta(meta) } };
	}
	case 'ratchet_step': {
		const peers = Object.keys(msg.payloads);
		return { summary: `ratchet step → ${peers.length} peer${peers.length === 1 ? '' : 's'}`,
			details: {
				peers: peers.join(', '),
				newEk: redact(msg.newEk),
				payload: redact(msg.payload),
				sig: redact(msg.sig),
				claim: redact(msg.claim),
				...flattenPayloads(msg.payloads),
				...flattenMeta(msg.meta as Record<string, unknown>),
			} };
	}
	case 'ek_update':
		return { summary: 'ek update', details: { ek: redact(msg.ek), claim: redact(msg.claim) } };
	case 'rekey':
		return { summary: 'rekey (lobby)',
			details: { ek: redact(msg.ek), ratchetEk: redact(msg.ratchetEk), claim: redact(msg.claim) } };
	default: {
		const t = (msg as { type: string }).type;
		return { summary: `unknown outbound: ${t}`, details: { type: t } };
	}
	}
}

function flattenMeta(meta: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
	const out: Record<string, string | number | boolean> = {};
	if (!meta) return out;
	for (const [k, v] of Object.entries(meta)) {
		if (v == null) continue;
		if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[`meta.${k}`] = v;
		else out[`meta.${k}`] = JSON.stringify(v);
	}
	return out;
}

function flattenPayloads(payloads: Record<string, { kemCt: string; encSeed: string; pn: number }>): Record<string, string | number> {
	const out: Record<string, string | number> = {};
	for (const [peer, p] of Object.entries(payloads)) {
		out[`payloads.${peer}.kemCt`]   = redact(p.kemCt);
		out[`payloads.${peer}.encSeed`] = redact(p.encSeed);
		out[`payloads.${peer}.pn`]      = p.pn;
	}
	return out;
}
