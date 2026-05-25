import type { InboundMsg, OutboundMsg } from './wireTypes.js';

// Lifted verbatim from eventLog.ts (summarize + the redact/escape/flatten
// helpers they depend on). No behaviour changes; the originals stay in place
// until the old code path is removed.

export function redact(b64: string | undefined | null): string {
	if (!b64) return '∅';
	const head = b64.slice(0, 8);
	const pad  = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
	const len  = Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
	return `${len}B "${head}…"`;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export function summarizeInbound(msg: InboundMsg): { summary: string; details: Record<string, string | number | boolean> } {
	switch (msg.type) {
	case 'room_created':
		return { summary: `room created <code>${escapeHtml(msg.roomId)}</code>`,
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
		return { summary: `<b>${escapeHtml(msg.username)}</b> joined`,
			details: { username: msg.username, ek: redact(msg.ek), ratchetEk: redact(msg.ratchetEk), claim: redact(msg.claim) } };
	case 'peer_left':
		return { summary: `<b>${escapeHtml(msg.username)}</b> left`,
			details: { username: msg.username } };
	case 'relay':
		return { summary: `relay <b>${escapeHtml(msg.from)}</b> → self`,
			details: { from: msg.from, payload: redact(msg.payload) } };
	case 'broadcast': {
		const meta = msg.meta as Record<string, unknown>;
		return { summary: `<b>${escapeHtml(msg.from)}</b> broadcast (${escapeHtml(String(meta?.type ?? 'msg'))})`,
			details: {
				from: msg.from,
				payload: redact(msg.payload),
				sig: redact(msg.sig),
				...flattenMeta(meta),
			} };
	}
	case 'ratchet_step_fwd':
		return { summary: `<b>${escapeHtml(msg.from)}</b> ratchet step`,
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
		return { summary: `<b>${escapeHtml(msg.from)}</b> ek update`,
			details: { from: msg.from, ek: redact(msg.ek), claim: redact(msg.claim) } };
	case 'rekeyed':
		return { summary: 'server confirmed rekey', details: {} };
	case 'error':
		return { summary: `server error: ${escapeHtml(msg.reason)}`, details: { reason: msg.reason } };
	default: {
		const t = (msg as { type: string }).type;
		return { summary: `unknown inbound: ${escapeHtml(t)}`, details: { type: t } };
	}
	}
}

export function summarizeOutbound(msg: OutboundMsg): { summary: string; details: Record<string, string | number | boolean> } {
	switch (msg.type) {
	case 'create':
		return { summary: 'create room', details: { adminToken: msg.adminToken ? '✓' : '∅' } };
	case 'join':
		return { summary: `join <code>${escapeHtml(msg.roomId)}</code>`,
			details: { roomId: msg.roomId, roomSecret: redact(msg.roomSecret) } };
	case 'identify':
		return { summary: `identify as <b>${escapeHtml(msg.username)}</b>`,
			details: { username: msg.username, ek: redact(msg.ek), ratchetEk: redact(msg.ratchetEk), claim: redact(msg.claim) } };
	case 'relay':
		return { summary: `relay self → <b>${escapeHtml(msg.to)}</b>`,
			details: { to: msg.to, payload: redact(msg.payload) } };
	case 'broadcast': {
		const meta = msg.meta as Record<string, unknown>;
		return { summary: `broadcast (${escapeHtml(String(meta?.type ?? 'msg'))})`,
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
		return { summary: `unknown outbound: ${escapeHtml(t)}`, details: { type: t } };
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
