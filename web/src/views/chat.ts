import {
	armorInvite,
	inviteFilename,
	INVITE_VERSION,
	serializeInvite,
} from '@covcom/lib';
import type { CovcomSession } from '../session.js';
import { getState, subscribe } from '../store.js';
import type { ChatItem, PeerView, Room } from '../store.js';
import { parseMarkup } from '@covcom/lib';
import { el, clear, formatBytes, senderColor } from '../util.js';
import { renderRich, renderDoc } from '../rich.js';
import { ICON_COG, ICON_SEND, ICON_ATTACH } from '../icons.js';
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
	// Self isn't in peers → colorIdx 0; peers carry their assigned slot.
	return senderColor(peer ? peer.colorIdx : 0);
}

// ── chat-item renderers ────────────────────────────────────────────────────

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
	const text = el('span', 'msg-text');
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
		const buf  = item.bytes.buffer.slice(item.bytes.byteOffset, item.bytes.byteOffset + item.bytes.byteLength) as ArrayBuffer;
		const blob = new Blob([buf], { type: item.mime });
		const url  = URL.createObjectURL(blob);
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

// ── bar variants ───────────────────────────────────────────────────────────

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

	function sendCurrent(): void {
		const text = textarea.value.trim();
		if (!text) return;
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

// ── mount ──────────────────────────────────────────────────────────────────

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

	let currentLobby: HTMLDivElement | null = null;

	function swapBar(toLobby: boolean): void {
		if (toLobby) {
			const s = getState().screen;
			if (s.name !== 'waiting') return;
			currentLobby = buildLobbyBar(s.room);
			regular.root.replaceWith(currentLobby);
			// Keep the regular bar node alive in memory so the textarea draft
			// survives a lobby round-trip.
		} else if (currentLobby) {
			currentLobby.replaceWith(regular.root);
			currentLobby = null;
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
		scrollHistory();
	}

	return (): void => {
		off();
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
