// Test harness for the CLI session state machine. Provides a fake global
// WebSocket (so `new WS(url)` in state.ts captures sends without a live
// server) and a real-crypto peer that produces valid wire frames.

import { generateKeypair, Session } from '@covcom/lib';
import { b64dec, b64enc } from '../src/util.ts';
import type { InboundMsg, OutboundMsg } from '../src/ws.ts';

// ─── fake WebSocket ────────────────────────────────────────────────────────

export class FakeWebSocket {
	url:       string;
	sent:      OutboundMsg[] = [];
	closed     = false;
	onopen:    (() => void) | null = null;
	onclose:   (() => void) | null = null;
	onmessage: ((e: { data: string }) => void) | null = null;

	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
	}

	send(data: string): void {
		this.sent.push(JSON.parse(data) as OutboundMsg);
	}
	close(): void {
		this.closed = true;
		this.onclose?.();
	}

	// drive the wrapper's lifecycle from the test
	open(): void {
		this.onopen?.();
	}
	emit(msg: InboundMsg): void {
		this.onmessage?.({ data: JSON.stringify(msg) });
	}

	static instances: FakeWebSocket[] = [];
}

export function installFakeWebSocket(): { last(): FakeWebSocket; restore(): void } {
	const real = (globalThis as { WebSocket?: unknown }).WebSocket;
	FakeWebSocket.instances = [];
	(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
	return {
		last: () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1],
		restore: () => {
			(globalThis as { WebSocket: unknown }).WebSocket = real;
		},
	};
}

// ─── real-crypto peer ────────────────────────────────────────────────────────

// A standalone peer Session that mints the wire frames a remote participant
// would send: its identity claim, its peer_joined announcement, and the chain
// seed it relays back to the local client.
export function makePeer(roomId: string, username: string) {
	const session = new Session(generateKeypair(), roomId);

	const claim = () => b64enc(session.identity.buildClaim(session.ratchetEk, username, roomId, session.epoch));

	return {
		session,
		username,
		peerJoined(): InboundMsg {
			return {
				type: 'peer_joined',
				username,
				ek: b64enc(session.ek),
				ratchetEk: b64enc(session.ratchetEk),
				claim: claim(),
			};
		},
		// wrap a chain seed for the local client, addressing it by `localName`,
		// using the local client's ek as advertised in its `identify` frame
		relaySeed(localEkB64: string, localName: string): InboundMsg {
			const blob = session.wrapChainSeedFor(b64dec(localEkB64), localName);
			return { type: 'relay', from: username, payload: b64enc(blob) };
		},
		dispose() {
			session.dispose();
		},
	};
}
