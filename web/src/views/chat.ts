import {
	armorInvite,
	inviteFilename,
	INVITE_VERSION,
	serializeInvite,
} from '@covcom/lib';
import type { CovcomSession } from '../session.js';
import { dispatch, getState, subscribe } from '../store.js';
import type { ChatItem, PeerView, Room } from '../store.js';
import { parseMarkup } from '@covcom/lib';
import { el, clear, formatBytes, peerColor } from '../util.js';
import { renderRich, renderDoc } from '../rich.js';
import { ICON_COG, ICON_SEND, ICON_ATTACH, ICON_LOG, ICON_FP, ICON_ESC } from '../icons.js';
import { setHtml } from '../safehtml.js';
import { mountSidebar } from './sidebar.js';
import { mountEventLog } from './event-log.js';
import { mountVerify } from './verify.js';

function b64enc(bytes: Uint8Array): string {
	let s = '';
	const CHUNK = 8192;
	for (let i = 0; i < bytes.length; i += CHUNK)
		s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
	return btoa(s);
}

function makeArmoredInvite(room: Room): string {
	return armorInvite(serializeInvite({
		version: INVITE_VERSION,
		roomId: room.id,
		roomSecret: b64enc(room.secret),
		dns: room.dns,
	}));
}

function colorFor(name: string, peers: Map<string, PeerView>): string {
	const peer = peers.get(name);
	// Self isn't in peers → colorIdx 0 → --peer0; peers carry their assigned slot.
	return peerColor(peer ? peer.colorIdx : 0);
}

// chat-item renderers

function liBase(sender: string, isSelf: boolean, peers: Map<string, PeerView>, clearLayout: boolean): HTMLLIElement {
	const li = document.createElement('li');
	li.className = `msg ${isSelf ? 'self' : 'peer'}${clearLayout ? ' clear' : ''}`;
	const name = el('span', 'msg-sender', `${sender}:`);
	name.style.color = colorFor(sender, peers);
	li.appendChild(name);
	return li;
}

function renderMessage(item: ChatItem & { kind: 'message' }, peers: Map<string, PeerView>): HTMLLIElement {
	const li = liBase(item.from, item.isSelf, peers, false);
	const text = el('div', 'msg-text');
	renderDoc(text, parseMarkup(item.text));
	li.appendChild(text);
	return li;
}

function renderFile(item: ChatItem & { kind: 'file' }, peers: Map<string, PeerView>): HTMLLIElement {
	const li    = liBase(item.from, item.isSelf, peers, true);
	const card  = el('article', 'file-card');
	const name  = el('p', 'file-name', item.filename);
	const meta  = el('p', 'file-meta', `${formatBytes(item.size)} · ${item.mime}`);
	const btnDl = el('button', 'btn-download', 'Download');
	btnDl.addEventListener('click', () => {
		const url  = URL.createObjectURL(item.blob);
		const a    = document.createElement('a');
		a.href     = url;
		a.download = item.filename;
		a.click();
		URL.revokeObjectURL(url);
	});
	card.append(name, meta, btnDl);
	li.appendChild(card);
	return li;
}

function renderSystem(item: ChatItem & { kind: 'system' }): HTMLLIElement {
	const li = document.createElement('li');
	li.className = `msg system${item.className ? ' ' + item.className : ''}`;
	const text = el('span', 'msg-text');
	renderRich(text, item.text);
	li.appendChild(text);
	return li;
}

function renderRatchet(item: ChatItem & { kind: 'ratchet' }, peers: Map<string, PeerView>): HTMLLIElement {
	const li = liBase(item.from, item.isSelf, peers, false);
	li.classList.add('ratchet');
	li.appendChild(el('span', 'msg-text', 'keys rotated'));
	return li;
}

function renderItem(item: ChatItem, peers: Map<string, PeerView>): HTMLLIElement {
	switch (item.kind) {
	case 'message': return renderMessage(item, peers);
	case 'file':    return renderFile(item, peers);
	case 'system':  return renderSystem(item);
	case 'ratchet': return renderRatchet(item, peers);
	}
}

// bar variants

interface RegularBar {
	root:     HTMLDivElement;
	textarea: HTMLTextAreaElement;
}

function buildRegularBar(session: CovcomSession): RegularBar {
	const bar = el('div', 'chat-bar') as HTMLDivElement;

	const textarea = document.createElement('textarea');
	textarea.id = 'chat-input';
	textarea.placeholder = 'type a message…';

	const btnSend = el('button', undefined, '');
	setHtml(btnSend, ICON_SEND);
	const btnAttach = el('button', undefined, '');
	setHtml(btnAttach, ICON_ATTACH);
	const btnRotate = el('button', undefined, '');
	setHtml(btnRotate, ICON_COG);

	const fileInput = document.createElement('input');
	fileInput.type           = 'file';
	fileInput.id             = 'file-input';
	fileInput.style.display  = 'none';

	// Mirror of the CLI slash dispatcher (cli/src/tui/views.ts). The three actions
	// have no web hotkey (Ctrl+R/E/V collide with the browser), so the typed command
	// is the keyboard path to them here.
	function leave(): void {
		session.dispose();
		dispatch({ type: 'RESET' });
		dispatch({ type: 'GOTO_LANDING' });
	}

	function showHelp(): void {
		const lines = [
			'available commands:',
			'  /exit (/quit, /q, /part)  leave the room',
			'  /ratchet                  rotate keys',
			'  /events                   toggle event log',
			'  /verify                   toggle verify pane',
			'  /help (/?)                show this list',
			'sidebar: +/- resize, Esc close (when the sidebar is focused)',
		];
		for (const line of lines) dispatch({ type: 'SYSTEM_APPENDED', text: line });
	}

	const commands: Record<string, () => void> = {
		exit: leave,
		quit: leave,
		q: leave,
		part: leave,
		ratchet: () => session.rotate(),
		events: () => dispatch({ type: 'SIDEBAR_TOGGLE', section: 'event-log' }),
		verify: () => dispatch({ type: 'SIDEBAR_TOGGLE', section: 'verify' }),
		help: showHelp,
		'?': showHelp,
	};

	function dispatchCommand(raw: string): void {
		const name = raw.slice(1).split(/\s+/)[0].toLowerCase();
		const fn   = commands[name];
		if (fn) {
			fn(); return;
		}
		dispatch({ type: 'SYSTEM_APPENDED', text: `unknown command: ${raw}. type /help for a list` });
	}

	function sendCurrent(): void {
		const text = textarea.value.trim();
		if (!text) return;
		if (text.startsWith('/')) {
			dispatchCommand(text); textarea.value = ''; return;
		}
		if (session.sendMessage(text)) textarea.value = '';
	}

	textarea.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendCurrent();
		}
	});
	btnSend.addEventListener('click', sendCurrent);
	btnRotate.addEventListener('click', () => {
		btnRotate.classList.add('spin');
		setTimeout(() => btnRotate.classList.remove('spin'), 2000);
		session.rotate();
	});
	btnAttach.addEventListener('click', () => fileInput.click());
	fileInput.addEventListener('change', () => {
		const file = fileInput.files?.[0];
		if (file) void session.sendFile(file);
		fileInput.value = '';
	});

	bar.append(textarea, btnSend, btnAttach, btnRotate, fileInput);
	return { root: bar, textarea };
}

function buildLobbyBar(room: Room): HTMLDivElement {
	const bar = el('div', 'chat-bar') as HTMLDivElement;
	const armored = makeArmoredInvite(room);

	const pre = el('pre', 'invite-block');
	pre.textContent = armored;

	const btnCopy = el('button', undefined, 'Copy');
	btnCopy.addEventListener('click', () => {
		navigator.clipboard.writeText(armored).then(() => {
			btnCopy.textContent = 'Copied!';
			setTimeout(() => {
				btnCopy.textContent = 'Copy';
			}, 1500);
		}).catch(() => {
			btnCopy.textContent = 'Copy failed - select manually';
			setTimeout(() => {
				btnCopy.textContent = 'Copy';
			}, 2000);
		});
	});

	const btnDl = el('button', 'btn-secondary', 'Download');
	btnDl.addEventListener('click', () => {
		const blob = new Blob([armored], { type: 'text/plain' });
		const url  = URL.createObjectURL(blob);
		const a    = document.createElement('a');
		a.href     = url;
		a.download = inviteFilename(room.id);
		a.click();
		URL.revokeObjectURL(url);
	});

	bar.append(pre, btnCopy, btnDl);
	return bar;
}

// Modal keys-display: the web counterpart to the CLI keys bar. Reached by
// pressing Escape in the message input; mirrors the CLI's r/e/v actions plus
// Escape to return. Every action closes the display and returns to the input:
// r ratchets, e/v toggle a sidebar panel, Escape just returns. Keyboard-only
// (no click handlers by design).
function buildKeysBar(session: CovcomSession, onExit: () => void): HTMLUListElement {
	const ul = el('ul', 'chat-bar') as HTMLUListElement;
	ul.id = 'keys';
	// Focusable so it receives keydown the moment we swap it in and focus it.
	ul.tabIndex = 0;

	const units: { key: string; icon: typeof ICON_COG; label: string }[] = [
		{ key: 'R',   icon: ICON_COG, label: 'Ratchet' },
		{ key: 'E',   icon: ICON_LOG, label: 'Events' },
		{ key: 'V',   icon: ICON_FP,  label: 'Verify' },
		{ key: 'ESC', icon: ICON_ESC, label: 'return to chat' },
	];

	for (const u of units) {
		const li      = el('li');
		const iconEl  = el('span', 'key-icon');
		setHtml(iconEl, u.icon);
		const kbd     = el('kbd', undefined, u.key);
		const p       = el('p');
		p.append(el('strong', undefined, u.label[0]), document.createTextNode(u.label.slice(1)));
		li.append(iconEl, kbd, p);
		ul.append(li);
	}

	ul.addEventListener('keydown', (e) => {
		const k = e.key.toLowerCase();
		if (k === 'escape') {
			e.preventDefault(); onExit(); return;
		}
		if (k === 'r')      {
			e.preventDefault(); session.rotate(); onExit(); return;
		}
		if (k === 'e')      {
			e.preventDefault(); dispatch({ type: 'SIDEBAR_TOGGLE', section: 'event-log' }); onExit(); return;
		}
		if (k === 'v')      {
			e.preventDefault(); dispatch({ type: 'SIDEBAR_TOGGLE', section: 'verify' }); onExit(); return;
		}
	});

	return ul;
}

// mount

export function mountChat(app: Element, session: CovcomSession): () => void {
	clear(app);

	const view    = el('section', 'view-chat');
	const history = document.createElement('ol');
	history.className = 'chat-history';
	history.id        = 'chat-history';

	const regular = buildRegularBar(session);
	view.append(history, regular.root);

	const overlay = el('div', 'drop-overlay', 'drop file to send');
	overlay.id = 'drop-overlay';

	app.append(view, overlay);

	// Sidebar must mount first; sections look up their bodies by data-section.
	const cleanupSidebar  = mountSidebar(view, session);
	const cleanupEventLog = mountEventLog(view);
	const cleanupVerify   = mountVerify(view);

	// Document-level DnD: the overlay shows while a drag is active anywhere on
	// the page. The relatedTarget==null check catches the cursor leaving the
	// viewport, which is the only dragleave we want to act on.
	const onDragEnter = (): void => {
		overlay.style.display = 'flex';
	};
	const onDragLeave = (e: DragEvent): void => {
		if (!e.relatedTarget) overlay.style.display = 'none';
	};
	const onDragOver = (e: DragEvent): void => {
		e.preventDefault();
	};
	const onDrop = (e: DragEvent): void => {
		e.preventDefault();
		overlay.style.display = 'none';
		const file = e.dataTransfer?.files[0];
		if (file) void session.sendFile(file);
	};
	document.addEventListener('dragenter', onDragEnter);
	document.addEventListener('dragleave', onDragLeave);
	document.addEventListener('dragover',  onDragOver);
	document.addEventListener('drop',      onDrop);

	let lastMessagesLen = 0;
	let lastScreenName  = '';
	let lastHideSystem: boolean | null = null;

	// The three bottom-bar variants (regular input, lobby invite, keys-display)
	// all swap through this one node tracker. The regular node stays alive in
	// memory while swapped out so the textarea draft survives a round-trip.
	let bottomNode: HTMLElement = regular.root;
	function setBottom(next: HTMLElement): void {
		if (next === bottomNode) return;
		bottomNode.replaceWith(next);
		bottomNode = next;
	}

	let keysMode = false;
	const keysBar = buildKeysBar(session, () => exitKeysMode());
	function enterKeysMode(): void {
		if (keysMode) return;
		keysMode = true;
		setBottom(keysBar);
		keysBar.focus();
	}
	function exitKeysMode(): void {
		if (!keysMode) return;
		keysMode = false;
		setBottom(regular.root);
		focusInput();
	}
	function focusInput(): void {
		regular.textarea.focus();
	}
	// Escape from the input opens the modal keys-display (Enter is handled inside
	// buildRegularBar). Only fires while the regular bar is mounted.
	const onInputEsc = (e: KeyboardEvent): void => {
		if (e.key === 'Escape') {
			e.preventDefault();
			enterKeysMode();
		}
	};
	regular.textarea.addEventListener('keydown', onInputEsc);

	let currentLobby: HTMLDivElement | null = null;

	function swapBar(toLobby: boolean): void {
		if (toLobby) {
			const s = getState().screen;
			if (s.name !== 'waiting') return;
			keysMode = false;            // the modal can't survive into the lobby
			currentLobby = buildLobbyBar(s.room);
			setBottom(currentLobby);
		} else {
			setBottom(regular.root);
			currentLobby = null;
			focusInput();
		}
	}

	function scrollHistory(): void {
		history.scrollTop = history.scrollHeight;
	}

	const off = subscribe(() => {
		const s = getState();

		if (s.ui.hideSystem !== lastHideSystem) {
			history.classList.toggle('hide-system', s.ui.hideSystem);
			lastHideSystem = s.ui.hideSystem;
		}

		// Bar variant: lobby when in standalone-waiting (everReady latched true,
		// shell mounts chat). Regular otherwise (ready, or transient others).
		if (s.screen.name !== lastScreenName) {
			if (s.screen.name === 'waiting') swapBar(true);
			else if (lastScreenName === 'waiting') swapBar(false);
			lastScreenName = s.screen.name;
		}

		// Delta-append. messages is mutated in place; comparing length is safe.
		if (s.messages.length !== lastMessagesLen) {
			for (let i = lastMessagesLen; i < s.messages.length; i++) {
				history.appendChild(renderItem(s.messages[i], s.peers));
			}
			lastMessagesLen = s.messages.length;
			scrollHistory();
		}
	});

	// Replay any existing items + initial flags so a chat remount picks up the
	// pre-mount state without needing a synthetic dispatch.
	{
		const s = getState();
		for (const item of s.messages) history.appendChild(renderItem(item, s.peers));
		lastMessagesLen = s.messages.length;
		lastHideSystem  = s.ui.hideSystem;
		history.classList.toggle('hide-system', s.ui.hideSystem);
		lastScreenName  = s.screen.name;
		if (s.screen.name === 'waiting') swapBar(true);
		else                             focusInput();
		scrollHistory();
	}

	return (): void => {
		off();
		regular.textarea.removeEventListener('keydown', onInputEsc);
		document.removeEventListener('dragenter', onDragEnter);
		document.removeEventListener('dragleave', onDragLeave);
		document.removeEventListener('dragover',  onDragOver);
		document.removeEventListener('drop',      onDrop);
		cleanupEventLog();
		cleanupVerify();
		cleanupSidebar();
		clear(app);
	};
}
