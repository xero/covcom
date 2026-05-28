export type OutboundMsg =
	| { type: 'create'; adminToken?: string }
	| { type: 'join'; roomId: string; roomSecret: string }
	| { type: 'identify'; username: string; ek: string; ratchetEk: string; claim: string }
	| { type: 'relay'; to: string; payload: string }
	| { type: 'broadcast'; payload: string; meta: Record<string, unknown>; sig: string }
	| { type: 'ratchet_step'; payloads: Record<string, { kemCt: string; encSeed: string; pn: number }>; newEk: string; payload: string; meta: Record<string, unknown>; sig: string; claim: string }
	| { type: 'ek_update'; ek: string; claim: string }
	| { type: 'rekey'; ek: string; ratchetEk: string; claim: string }

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
	| { type: 'rekeyed' }

export class WS {
	private _ws: WebSocket;
	onMessage: (msg: InboundMsg) => void = () => { /* noop */ };
	onClose:   () => void = () => { /* noop */ };
	onOpen:    () => void = () => { /* noop */ };

	// Tap hooks fire on every successfully parsed inbound and every outbound,
	// regardless of phase. Used by the sidebar event log; errors are swallowed
	// so a misbehaving tap can't break the session.
	onWireIn:  (msg: InboundMsg)  => void = () => { /* noop */ };
	onWireOut: (msg: OutboundMsg) => void = () => { /* noop */ };

	constructor(url: string) {
		this._ws           = new WebSocket(url);
		this._ws.onopen    = () => this.onOpen();
		this._ws.onclose   = () => this.onClose();
		this._ws.onmessage = (e: MessageEvent) => {
			let msg: InboundMsg;
			try {
				msg = JSON.parse(e.data as string) as InboundMsg;
			} catch {
				return; // drop malformed JSON only
			}
			try {
				this.onWireIn(msg);
			} catch { /* tap errors don't break session */ }
			try {
				this.onMessage(msg);
			} catch {
				// drop the malformed or attacker-controlled payload; session state intact
			}
		};
	}

	send(msg: OutboundMsg): void {
		try {
			this.onWireOut(msg);
		} catch { /* tap errors don't break send */ }
		this._ws.send(JSON.stringify(msg));
	}
	close(): void {
		this._ws.close();
	}
}
