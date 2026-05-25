import type { CovcomSession } from './session.js';
import { dispatch, getState } from './store.js';

// Raw `fatal.reason` codes (server's ErrorMsg union + the session's local
// failure codes) mapped to user-facing strings. UI concern, not protocol;
// session emits codes, bridge translates.
const friendly: Record<string, string> = {
	'room_full': 'Room is full.',
	'not_found': 'Room not found.',
	'username_taken': 'That username is taken in this room.',
	'forbidden': 'Server rejected the connection.',
	'invite_invalid': 'Invite is malformed or corrupt.',
	'wasm_init_fail': 'Crypto setup failed; try reloading.',
	'invalid_server': 'That server address looks invalid - please check it.',
	'unreachable': 'Could not reach the server - check the address and that it is running.',
};

// Subscribes to every session event and dispatches the corresponding action
// per the table in ./TASKS/00-ARCHITECTURE.md. Returns a single unsubscribe.
export function wireBridge(session: CovcomSession): () => void {
	const offs: (() => void)[] = [];

	offs.push(session.on('phase', ({ phase, room, username }) => {
		if (phase === 'joining') dispatch({ type: 'GOTO_JOINING', room, username });
		if (phase === 'waiting') dispatch({ type: 'GOTO_WAITING', room, username });
		if (phase === 'ready')   dispatch({ type: 'GOTO_READY',   room, username });
	}));

	offs.push(session.on('peer-joined', ({ username, fingerprint }) => {
		dispatch({ type: 'PEER_ADDED', username, fingerprint });
		dispatch({ type: 'SYSTEM_APPENDED', text: `<b>${username}</b> joined` });
		dispatch({ type: 'EVENT_LOGGED', entry: {
			direction: 'local',
			kind: 'join',
			summary: `<b>${username}</b> joined`,
			details: { username, fpHex: fingerprint.hex },
		} });
	}));

	// `peer-known` fpChanged is read from the store, not from a captured local,
	// so it stays correct across reconnect cycles.
	offs.push(session.on('peer-known', ({ username, fingerprint }) => {
		const prev      = getState().peers.get(username);
		const fpChanged = !!prev && prev.fingerprint.hex !== fingerprint.hex;
		dispatch({ type: 'PEER_ADDED', username, fingerprint });
		if (fpChanged) {
			dispatch({
				type: 'SYSTEM_APPENDED',
				text: `<b>${username}</b> reconnected: verify their fingerprint`,
				className: 'rejoin fp-changed',
			});
		} else {
			dispatch({
				type: 'SYSTEM_APPENDED',
				text: `<b>${username}</b> reconnected`,
				className: 'rejoin',
			});
		}
		dispatch({ type: 'EVENT_LOGGED', entry: {
			direction: 'local',
			kind: 'rejoin',
			summary: `<b>${username}</b> reconnected${fpChanged ? ' (fp changed)' : ''}`,
			details: { username, fpHex: fingerprint.hex, fpChanged },
		} });
	}));

	offs.push(session.on('peer-left', ({ username }) => {
		dispatch({ type: 'PEER_REMOVED', username });
		dispatch({ type: 'SYSTEM_APPENDED', text: `<b>${username}</b> left` });
		dispatch({ type: 'EVENT_LOGGED', entry: {
			direction: 'local',
			kind: 'part',
			summary: `<b>${username}</b> left`,
			details: { username },
		} });
	}));

	offs.push(session.on('local-fingerprint-changed', ({ fingerprint }) => {
		dispatch({ type: 'LOCAL_FINGERPRINT', fingerprint });
	}));

	offs.push(session.on('message', (m) => {
		dispatch({ type: 'MESSAGE_APPENDED', item: {
			kind: 'message', from: m.from, text: m.text, isSelf: m.isSelf, ts: m.ts,
		} });
		dispatch({ type: 'EVENT_LOGGED', entry: {
			direction: m.isSelf ? 'out' : 'in',
			kind: 'message',
			summary: `${m.from}: ${m.text.slice(0, 40)}`,
			details: { from: m.from, epoch: m.epoch, counter: m.counter },
		} });
	}));

	offs.push(session.on('file', (f) => {
		dispatch({ type: 'FILE_APPENDED', item: {
			kind: 'file', from: f.from, filename: f.filename, mime: f.mime,
			size: f.size, bytes: f.bytes, isSelf: f.isSelf, ts: f.ts,
		} });
		dispatch({ type: 'EVENT_LOGGED', entry: {
			direction: f.isSelf ? 'out' : 'in',
			kind: 'file',
			summary: `${f.from}: ${f.filename}`,
			details: { from: f.from, filename: f.filename, size: f.size },
		} });
	}));

	offs.push(session.on('ratchet', (r) => {
		dispatch({ type: 'RATCHET_APPENDED', from: r.from, isSelf: r.isSelf });
		dispatch({ type: 'EVENT_LOGGED', entry: {
			direction: r.isSelf ? 'out' : 'in',
			kind: 'ratchet',
			summary: `${r.from}: keys rotated`,
			details: { from: r.from },
		} });
	}));

	offs.push(session.on('wire', (w) => {
		dispatch({ type: 'EVENT_LOGGED', entry: {
			direction: w.direction,
			kind: w.kind,
			summary: w.summary,
			details: w.details,
		} });
	}));

	offs.push(session.on('log', (l) => {
		dispatch({ type: 'EVENT_LOGGED', entry: {
			direction: 'local',
			kind: l.kind,
			summary: l.summary,
			details: l.details ?? {},
		} });
	}));

	offs.push(session.on('info', (i) => {
		dispatch({ type: 'SYSTEM_APPENDED', text: i.text });
		dispatch({ type: 'EVENT_LOGGED', entry: {
			direction: 'local',
			kind: i.kind,
			summary: i.text,
			details: i.details ?? {},
		} });
	}));

	offs.push(session.on('fatal', (f) => {
		const text = friendly[f.reason] ?? 'Connection failed.';
		dispatch({ type: 'EVENT_LOGGED', entry: {
			direction: 'local',
			kind: 'fatal',
			summary: f.reason,
			details: { reason: f.reason },
		} });
		dispatch({ type: 'RESET' });
		dispatch({ type: 'GOTO_LANDING', error: text, prefill: f.prefill });
	}));

	offs.push(session.on('connection-lost', () => {
		dispatch({ type: 'SYSTEM_APPENDED', text: 'connection lost; reconnecting…', className: 'reconnect' });
		dispatch({ type: 'EVENT_LOGGED', entry: {
			direction: 'local',
			kind: 'reconnect',
			summary: 'connection lost',
			details: {},
		} });
	}));

	offs.push(session.on('connection-restored', ({ downMs }) => {
		dispatch({ type: 'SYSTEM_APPENDED', text: 'connection restored', className: 'reconnect' });
		dispatch({ type: 'EVENT_LOGGED', entry: {
			direction: 'local',
			kind: 'reconnect',
			summary: 'connection restored',
			details: { downMs },
		} });
	}));

	return () => {
		for (const off of offs) off();
	};
}
