export type OutboundMsg =
	| { type: 'create'; adminToken?: string }
	| { type: 'join'; roomId: string; roomSecret: string }
	| { type: 'identify'; username: string; ek: string; ratchetEk: string }
	| { type: 'relay'; to: string; payload: string }
	| { type: 'broadcast'; payload: string; meta: Record<string, unknown> }
	| { type: 'ratchet_step'; payloads: Record<string, { kemCt: string; encSeed: string; pn: number }>; newEk: string; payload: string; meta: Record<string, unknown> }
	| { type: 'ek_update'; ek: string }
	| { type: 'rekey'; ek: string; ratchetEk: string }

export type InboundMsg =
	| { type: 'room_created'; roomId: string; roomSecret: string }
	| { type: 'joined'; members: { username: string; ek: string; ratchetEk: string }[] }
	| { type: 'peer_joined'; username: string; ek: string; ratchetEk: string }
	| { type: 'peer_left'; username: string }
	| { type: 'relay'; from: string; payload: string }
	| { type: 'broadcast'; from: string; payload: string; meta: Record<string, unknown> }
	| { type: 'error'; reason: string }
	| { type: 'ratchet_step_fwd'; from: string; kemCt: string; encSeed: string; pn: number; newEk: string; payload: string; meta: Record<string, unknown> }
	| { type: 'ek_update_fwd'; from: string; ek: string }
	| { type: 'rekeyed' }

export class WS {
	private _ws: WebSocket;
	onMessage: (msg: InboundMsg) => void = () => { /* noop */ };
	onClose:   () => void = () => { /* noop */ };
	onOpen:    () => void = () => { /* noop */ };

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
				this.onMessage(msg);
			} catch {
				// drop — malformed or attacker-controlled payload; session state intact
			}
		};
	}

	send(msg: OutboundMsg): void {
		this._ws.send(JSON.stringify(msg));
	}
	close(): void {
		this._ws.close();
	}
}
