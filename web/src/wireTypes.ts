// WebSocket wire-format type unions. Mirrors `server/src/types.ts`; consumed by
// both the session (which owns the WebSocket) and wireSummary (which formats
// each frame for the event log). No runtime — types only.

export type OutboundMsg =
	| { type: 'create'; adminToken?: string }
	| { type: 'join'; roomId: string; roomSecret: string }
	| { type: 'identify'; username: string; ek: string; ratchetEk: string; claim: string }
	| { type: 'relay'; to: string; payload: string }
	| { type: 'broadcast'; payload: string; meta: Record<string, unknown>; sig: string }
	| { type: 'ratchet_step'; payloads: Record<string, { kemCt: string; encSeed: string; pn: number }>; newEk: string; payload: string; meta: Record<string, unknown>; sig: string; claim: string }
	| { type: 'ek_update'; ek: string; claim: string }
	| { type: 'rekey'; ek: string; ratchetEk: string; claim: string };

export type InboundMsg =
	| { type: 'room_created'; roomId: string; roomSecret: string }
	| { type: 'joined'; members: { username: string; ek: string; ratchetEk: string; claim: string }[] }
	| { type: 'peer_joined'; username: string; ek: string; ratchetEk: string; claim: string }
	| { type: 'peer_left'; username: string }
	| { type: 'relay'; from: string; payload: string }
	| { type: 'broadcast'; from: string; payload: string; meta: Record<string, unknown>; sig: string }
	| { type: 'error'; reason: string }
	| { type: 'ratchet_step_fwd'; from: string; kemCt: string; encSeed: string; pn: number; newEk: string; payload: string; meta: Record<string, unknown>; sig: string; claim: string }
	| { type: 'ek_update_fwd'; from: string; ek: string; claim: string }
	| { type: 'rekeyed' };
