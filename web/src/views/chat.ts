import { inviteFilename } from '@covcom/lib';
import { el, clear, formatBytes, senderColor } from '../util.js';

interface PeerInfo {
	ek:        string
	ratchetEk: string
	colorIdx:  number
}

interface ChatOpts {
	username: string
	peers:    Map<string, PeerInfo>
	onSend:   (text: string) => void
	onFile:   (file: File) => void
	onRotate: () => void
}

interface MsgOpts {
	sender:    string
	text:      string
	isSelf:    boolean
	className?: string
}

interface FileOpts {
	sender:   string
	filename: string
	size:     number
	mime:     string
	isSelf:   boolean
}

let _history: HTMLOListElement | null = null;
let _bar:     HTMLDivElement    | null = null;
let _barSaved: Node[] = [];
let _peers = new Map<string, PeerInfo>();
let _hideSystem = false;

export function renderChat(root: Element, opts: ChatOpts): void {
	clear(root);
	_peers    = opts.peers;
	_barSaved = [];

	const view    = el('section', 'view-chat');
	const history = document.createElement('ol');
	history.className = 'chat-history';
	history.id = 'chat-history';
	_history = history;
	if (_hideSystem) _history.classList.add('hide-system');

	const bar = el('div', 'chat-bar');
	_bar = bar as HTMLDivElement;

	const textarea = document.createElement('textarea');
	textarea.id = 'chat-input';
	textarea.rows = 5;
	textarea.placeholder = 'type a message\u2026';

	const btnSend   = el('button', undefined, 'Send');
	const btnRotate = el('button', undefined, '\uD83D\uDD12');
	const btnToggle = el('button', 'btn-toggle-system', 'events \u25bc');
	btnToggle.title = 'hide system messages';
	btnToggle.addEventListener('click', () => {
		_hideSystem = !_hideSystem;
		_history?.classList.toggle('hide-system', _hideSystem);
		btnToggle.textContent = _hideSystem ? 'events \u25b6' : 'events \u25bc';
		btnToggle.title = _hideSystem ? 'show system messages' : 'hide system messages';
	});
	const btnAttach = el('button', undefined, 'Attach');
	const fileInput = document.createElement('input');
	fileInput.type = 'file';
	fileInput.id = 'file-input';
	fileInput.style.display = 'none';

	const overlay = el('div', 'drop-overlay', 'drop file to send');
	overlay.id = 'drop-overlay';

	function sendCurrentMessage(): void {
		const text = textarea.value.trim();
		if (!text) return;
		textarea.value = '';
		opts.onSend(text);
	}

	textarea.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendCurrentMessage();
		}
	});
	btnSend.addEventListener('click', sendCurrentMessage);
	btnRotate.addEventListener('click', () => opts.onRotate());

	btnAttach.addEventListener('click', () => fileInput.click());
	fileInput.addEventListener('change', () => {
		const file = fileInput.files?.[0];
		if (file) opts.onFile(file);
		fileInput.value = '';
	});

	document.addEventListener('dragenter', () => {
		overlay.style.display = 'flex';
	});
	document.addEventListener('dragleave', (e) => {
		if (!e.relatedTarget) overlay.style.display = 'none';
	});
	document.addEventListener('dragover', (e) => e.preventDefault());
	document.addEventListener('drop', (e) => {
		e.preventDefault();
		overlay.style.display = 'none';
		const file = e.dataTransfer?.files[0];
		if (file) opts.onFile(file);
	});

	bar.append(textarea, btnSend, btnRotate, btnToggle, btnAttach, fileInput);
	view.append(history, bar);
	root.append(view, overlay);
}

function _colorIdx(sender: string): number {
	return _peers.get(sender)?.colorIdx ?? 0;
}

function _msgLi(sender: string, isSelf: boolean): HTMLLIElement {
	const li = document.createElement('li');
	li.className = `msg ${isSelf ? 'self' : 'peer'}`;

	const color = senderColor(_colorIdx(sender));
	const name  = el('span', 'msg-sender', `${sender}:`);
	name.style.color = color;
	li.appendChild(name);
	return li;
}

function _scroll(): void {
	if (_history) _history.scrollTop = _history.scrollHeight;
}

export function appendMessage(opts: MsgOpts): void {
	if (!_history) return;
	const li = _msgLi(opts.sender, opts.isSelf);
	if (opts.className) li.classList.add(opts.className);
	li.appendChild(el('span', 'msg-text', opts.text));
	_history.appendChild(li);
	_scroll();
}

export function appendFile(opts: FileOpts, bytes: Uint8Array): void {
	if (!_history) return;
	const li = _msgLi(opts.sender, opts.isSelf);

	const card  = el('article', 'file-card');
	const name  = el('p', 'file-name', opts.filename);
	const meta  = el('p', 'file-meta', `${formatBytes(opts.size)} \u00b7 ${opts.mime}`);
	const btnDl = el('button', 'btn-download', 'Download');

	btnDl.addEventListener('click', () => {
		const buf  = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
		const blob = new Blob([buf], { type: opts.mime });
		const url  = URL.createObjectURL(blob);
		const a    = document.createElement('a');
		a.href     = url;
		a.download = opts.filename;
		a.click();
		URL.revokeObjectURL(url);
	});

	card.append(name, meta, btnDl);
	li.appendChild(card);
	_history.appendChild(li);
	_scroll();
}

export function showLobbyBar(armoredInvite: string, roomId: string): void {
	if (!_history || !_bar) return;
	_barSaved = Array.from(_bar.childNodes);
	_bar.innerHTML = '';

	const pre = el('pre', 'invite-block');
	pre.textContent = armoredInvite;

	const btnCopy = el('button', undefined, 'Copy');
	btnCopy.addEventListener('click', () => {
		navigator.clipboard.writeText(armoredInvite).catch(() => { /* ignore */ });
	});

	const btnDl = el('button', 'btn-secondary', 'Download');
	btnDl.addEventListener('click', () => {
		const blob = new Blob([armoredInvite], { type: 'text/plain' });
		const url  = URL.createObjectURL(blob);
		const a    = document.createElement('a');
		a.href     = url;
		a.download = inviteFilename(roomId);
		a.click();
		URL.revokeObjectURL(url);
	});

	_bar.append(pre, btnCopy, btnDl);
}

export function hideLobbyBar(): void {
	if (!_history || !_bar) return;
	_bar.innerHTML = '';
	for (const child of _barSaved) _bar.appendChild(child);
	_barSaved = [];
}
