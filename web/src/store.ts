import type { FingerprintSurface } from '@covcom/lib';

export type Screen =
	| { name: 'landing'; error?: string; prefill?: { username?: string } }
	| { name: 'joining'; room: Room; username: string }
	| { name: 'waiting'; room: Room; username: string }
	| { name: 'ready'; room: Room; username: string };

export interface Room {
	id:     string;
	secret: Uint8Array;
	dns?:   string;
}

export interface PeerView {
	fingerprint: FingerprintSurface;
	colorIdx:    number;
}

export type ChatItem =
	| { kind: 'message'; from: string; text: string; isSelf: boolean; ts: number }
	| { kind: 'file'; from: string; filename: string; mime: string; size: number; bytes: Uint8Array; isSelf: boolean; ts: number }
	| { kind: 'system'; text: string; className?: string; ts: number }
	| { kind: 'ratchet'; from: string; isSelf: boolean; ts: number };

export interface EventLogEntry {
	id:        number;
	direction: 'in' | 'out' | 'local';
	kind:      string;
	summary:   string;
	details:   Record<string, unknown>;
	ts:        number;
}

export interface AppState {
	screen:            Screen;
	peers:             Map<string, PeerView>;
	localFingerprint?: FingerprintSurface;
	messages:          ChatItem[];
	events:            EventLogEntry[];
	ui: {
		sidebarOpen:     boolean;
		activeSection:   'event-log' | 'verify' | null;
		sidebarWidthPct: number;
		hideSystem:      boolean;
	};
}

export type Action =
	| { type: 'GOTO_LANDING'; error?: string; prefill?: { username?: string } }
	| { type: 'GOTO_JOINING'; room: Room; username: string }
	| { type: 'GOTO_WAITING'; room: Room; username: string }
	| { type: 'GOTO_READY'; room: Room; username: string }
	| { type: 'PEER_ADDED'; username: string; fingerprint: FingerprintSurface }
	| { type: 'PEER_REMOVED'; username: string }
	| { type: 'LOCAL_FINGERPRINT'; fingerprint: FingerprintSurface }
	| { type: 'MESSAGE_APPENDED'; item: ChatItem & { kind: 'message' } }
	| { type: 'FILE_APPENDED'; item: ChatItem & { kind: 'file' } }
	| { type: 'SYSTEM_APPENDED'; text: string; className?: string }
	| { type: 'RATCHET_APPENDED'; from: string; isSelf: boolean }
	| { type: 'EVENT_LOGGED'; entry: Omit<EventLogEntry, 'id' | 'ts'> & { ts?: number } }
	| { type: 'SIDEBAR_TOGGLE'; section: 'event-log' | 'verify' }
	| { type: 'SIDEBAR_RESIZE'; pct: number }
	| { type: 'SYSTEM_TOGGLE' }
	| { type: 'RESET' };

export const SIDEBAR_DEFAULTS = { DEFAULT_PCT: 30, MIN_PCT: 10, MAX_PCT: 70 };

const EVENT_LOG_CAP = 500;
let nextEventId = 1;

function initialState(): AppState {
	return {
		screen: { name: 'landing' },
		peers: new Map(),
		messages: [],
		events: [],
		ui: {
			sidebarOpen: false,
			activeSection: null,
			sidebarWidthPct: SIDEBAR_DEFAULTS.DEFAULT_PCT,
			hideSystem: false,
		},
	};
}

// Mutates state in place. Listeners self-gate on cached slice values rather than
// reference equality, so push/set/clear are intentional — no spreads, no realloc.
function reduce(state: AppState, action: Action): void {
	switch (action.type) {
	case 'GOTO_LANDING':
		state.screen = { name: 'landing', error: action.error, prefill: action.prefill };
		break;
	case 'GOTO_JOINING':
		state.screen = { name: 'joining', room: action.room, username: action.username };
		break;
	case 'GOTO_WAITING':
		state.screen = { name: 'waiting', room: action.room, username: action.username };
		break;
	case 'GOTO_READY':
		state.screen = { name: 'ready', room: action.room, username: action.username };
		break;
	case 'PEER_ADDED': {
		const existing = state.peers.get(action.username);
		if (existing) {
			existing.fingerprint = action.fingerprint;
		} else {
			// Self uses index 0 (per arch); peers start at 1 so the first peer
			// doesn't collide with self's color slot.
			state.peers.set(action.username, { fingerprint: action.fingerprint, colorIdx: state.peers.size + 1 });
		}
		break;
	}
	case 'PEER_REMOVED':
		state.peers.delete(action.username);
		break;
	case 'LOCAL_FINGERPRINT':
		state.localFingerprint = action.fingerprint;
		break;
	case 'MESSAGE_APPENDED':
		state.messages.push(action.item);
		break;
	case 'FILE_APPENDED':
		state.messages.push(action.item);
		break;
	case 'SYSTEM_APPENDED':
		state.messages.push({ kind: 'system', text: action.text, className: action.className, ts: Date.now() });
		break;
	case 'RATCHET_APPENDED':
		state.messages.push({ kind: 'ratchet', from: action.from, isSelf: action.isSelf, ts: Date.now() });
		break;
	case 'EVENT_LOGGED': {
		const entry: EventLogEntry = {
			id: nextEventId++,
			direction: action.entry.direction,
			kind: action.entry.kind,
			summary: action.entry.summary,
			details: action.entry.details,
			ts: action.entry.ts ?? Date.now(),
		};
		state.events.push(entry);
		while (state.events.length > EVENT_LOG_CAP) state.events.shift();
		break;
	}
	case 'SIDEBAR_TOGGLE':
		// closed → open + show; open on another section → switch; open on this → close
		if (!state.ui.sidebarOpen || state.ui.activeSection !== action.section) {
			state.ui.sidebarOpen = true;
			state.ui.activeSection = action.section;
		} else {
			state.ui.sidebarOpen = false;
		}
		break;
	case 'SIDEBAR_RESIZE':
		state.ui.sidebarWidthPct = action.pct;
		break;
	case 'SYSTEM_TOGGLE':
		state.ui.hideSystem = !state.ui.hideSystem;
		break;
	case 'RESET':
		state.screen = { name: 'landing' };
		state.peers.clear();
		state.localFingerprint = undefined;
		state.messages.length = 0;
		state.events.length = 0;
		nextEventId = 1;
		break;
	}
}

const state = initialState();
const listeners = new Set<() => void>();

export function getState(): AppState {
	return state;
}

export function subscribe(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export function dispatch(action: Action): void {
	reduce(state, action);
	for (const fn of listeners) fn();
}
