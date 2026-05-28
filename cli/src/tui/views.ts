import { join, resolve } from 'path';
import { readdirSync } from 'fs';
import { parseArmoredInvite, inviteFilename } from '@covcom/lib';
import type { InvitePayload, FingerprintSurface } from '@covcom/lib';
import { Screen, Theme, ColorValue, loadTheme, colorFg, colorBg, ansi } from './screen.js';
import { parseInput, InputEvent } from './keys.js';
import { FocusRing } from './focus.js';
import { TextInput, TextArea, Button, ScrollView, Sidebar, Widget, drawModal } from './widgets.js';
import type { SidebarMode, ModalOpts } from './widgets.js';
import { readConfig, readSidebarWidth, writeSidebarWidth, SIDEBAR_MIN_COLS } from '../config.js';
import { resolveUniqueFilename } from '../util.js';
import { BANNER } from './banner.js';

// ─── banner ──────────────────────────────────────────────────────────────────

const BANNER_LINES = BANNER.split('\n').filter(l => l.length > 0);
const BANNER_W     = 56;  // visible cell width of the banner
const BANNER_H     = BANNER_LINES.length;
const BANNER_TOP   = 2;   // row offset from top of screen

// draw the banner if there's room; skips silently when terminal is too small.
// formY is the first row of the form below it. The banner only renders if it
// won't collide.
function drawBanner(scr: Screen, formY: number): void {
	if (scr.w < BANNER_W + 4) return;
	if (formY < BANNER_TOP + BANNER_H + 1) return;
	const ox = Math.floor((scr.w - BANNER_W) / 2);
	for (let i = 0; i < BANNER_LINES.length; i++) {
		scr.moveTo(ox, BANNER_TOP + i);
		scr.write(BANNER_LINES[i] + ansi.reset);
	}
}

// ─── module-level state for appendMessage / appendFile ───────────────────────

let viewGen  = 0;
let _scrollView:    ScrollView | null  = null;
let _chatScreen:    Screen     | null  = null;
let _chatRender:    (() => void) | null = null;
let _resizeCleanup: (() => void) | null = null;
let _errorDisplay:  ((msg: string) => void) | null = null;
let _sidebar:       Sidebar    | null  = null;
let _focusRing:     FocusRing  | null  = null;

interface ModalState { title: string; body: string; accent?: ColorValue }
let _modal:      ModalState | null = null;
let _activeView: { gen: number; scr: Screen; render: () => void; theme: Theme } | null = null;

function disposeSidebar(): void {
	if (_sidebar) {
		_sidebar.dispose(); _sidebar = null;
	}
}

function chatDoRender() {
	if (!_chatScreen || !_chatRender) return;
	_chatScreen.beginRender();
	_chatScreen.clear();
	_chatRender();
	if (_modal && _activeView && _activeView.scr === _chatScreen) {
		drawModal(_chatScreen, _activeView.theme, _modal);
	}
	_chatScreen.endRender();
}

// ─── shared view setup ───────────────────────────────────────────────────────

function setupView(scr: Screen, theme: Theme, render: () => void, onEv: (ev: InputEvent) => void) {
	viewGen++;
	const gen = viewGen;
	if (_resizeCleanup) {
		_resizeCleanup(); _resizeCleanup = null;
	}
	process.stdin.removeAllListeners('data');

	const renderAll = () => {
		render();
		if (_modal) drawModal(scr, theme, _modal);
	};

	_modal = null;
	_activeView = { gen, scr, render: renderAll, theme };

	const handle = (ev: InputEvent) => {
		if (_modal) {
			if (ev.kind === 'key') {
				if (ev.key.ctrl && ev.key.name === 'c') {
					process.emit('SIGINT'); return;
				}
				_modal = null; scr.markDirty(); return;
			}
			if (ev.kind === 'mouse' && ev.mouse.type === 'click') {
				_modal = null; scr.markDirty(); return;
			}
			return;
		}
		onEv(ev);
	};

	process.stdin.on('data', (buf: Buffer) => {
		handle(parseInput(buf));
		if (viewGen === gen && scr.needsRender()) {
			scr.beginRender(); scr.clear(); renderAll(); scr.endRender();
		}
	});

	const onResize = () => {
		scr.needsRender();
		scr.beginRender(); scr.clear(); renderAll(); scr.endRender();
	};
	process.stdout.on('resize', onResize);
	_resizeCleanup = () => process.stdout.removeListener('resize', onResize);

	scr.beginRender(); scr.clear(); renderAll(); scr.endRender();
}

export function showModal(opts: ModalOpts): void {
	if (!_activeView) return;
	const captured = _activeView;
	_modal = { title: opts.title, body: opts.body, accent: opts.accent };
	captured.scr.beginRender();
	captured.scr.clear();
	captured.render();
	captured.scr.endRender();
}

function clickHit(widgets: Widget[], x: number, y: number): Widget | null {
	for (const w of widgets)
		if (x >= w.rect.x && x < w.rect.x + w.rect.w && y >= w.rect.y && y < w.rect.y + w.rect.h)
			return w;
	return null;
}

// ─── clipboard copy ──────────────────────────────────────────────────────────

async function tryCopy(text: string, copyCmd?: string): Promise<boolean> {
	const buf = Buffer.from(text);
	const cmds = copyCmd
		? [copyCmd.trim().split(/\s+/)]
		: [['pbcopy'], ['xclip', '-selection', 'clipboard'], ['xsel', '-b'], ['wl-copy']];

	for (const cmd of cmds) {
		try {
			const proc = Bun.spawn(cmd, { stdin: buf });
			const code = await proc.exited;
			if (code === 0) return true;
		} catch { /* try next */ }
	}
	return false;
}

// ─── tab completion ──────────────────────────────────────────────────────────

function getCompletions(val: string): string[] {
	const i      = val.lastIndexOf('/');
	const dir    = i >= 0 ? (val.slice(0, i + 1) || '/') : '.';
	const prefix = i >= 0 ? val.slice(i + 1) : val;
	try {
		return readdirSync(dir)
			.filter(e => e.startsWith(prefix))
			.map(e => (i >= 0 ? dir : '') + e);
	} catch {
		return [];
	}
}

// ─── renderLanding ───────────────────────────────────────────────────────────

export function renderLanding(
	scr: Screen,
	opts: {
		config:      { server?: string; username?: string }
		onCreate:    (server: string, username: string, adminToken?: string) => void
		onJoinClick: (username: string) => void
	},
): void {
	disposeSidebar();
	_scrollView = null; _chatScreen = null; _chatRender = null; _errorDisplay = null;
	const theme = loadTheme(readConfig());

	let errorLine = '';

	const serverInput   = new TextInput('server',    opts.config.server   ?? '');
	const usernameInput = new TextInput('username',  opts.config.username ?? '');
	const tokenInput    = new TextInput('authToken', '');
	const createBtn     = new Button('create', 'Create Room', () => {
		const server   = serverInput.value.trim();
		const username = usernameInput.value.trim();
		if (!server || !username) return;
		opts.onCreate(server, username, tokenInput.value.trim() || undefined);
	});
	const joinBtn = new Button('join', 'Join Room', () => {
		const username = usernameInput.value.trim();
		if (!username) return;
		opts.onJoinClick(username);
	});

	const ring    = new FocusRing();
	ring.register('server'); ring.register('username'); ring.register('authToken');
	ring.register('create'); ring.register('join');
	const widgets: Widget[] = [serverInput, usernameInput, tokenInput, createBtn, joinBtn];

	_errorDisplay = (msg: string) => {
		errorLine = msg;
		scr.markDirty();
		scr.beginRender(); scr.clear(); render(); scr.endRender();
	};

	function render() {
		scr.hideCursor();
		const cw = Math.min(scr.w - 8, 44);
		const ox = Math.floor((scr.w - cw) / 2);
		const oy = Math.max(1, Math.floor((scr.h - 14) / 2));

		scr.fillRect(1, 1, scr.w, scr.h, theme.bg);
		drawBanner(scr, oy);

		scr.moveTo(ox, oy);   scr.write(colorFg(theme.fg) + 'Server DNS:' + ansi.reset);
		serverInput.render(scr, { x: ox, y: oy + 1, w: cw, h: 1 }, ring.isFocused('server'), theme);

		scr.moveTo(ox, oy + 3); scr.write(colorFg(theme.fg) + 'Username:' + ansi.reset);
		usernameInput.render(scr, { x: ox, y: oy + 4, w: cw, h: 1 }, ring.isFocused('username'), theme);

		scr.moveTo(ox, oy + 6); scr.write(colorFg(theme.fg) + 'Server Password (optional):' + ansi.reset);
		tokenInput.render(scr, { x: ox, y: oy + 7, w: cw, h: 1 }, ring.isFocused('authToken'), theme);

		createBtn.render(scr, { x: ox,      y: oy + 10, w: 14, h: 1 }, ring.isFocused('create'), theme);
		joinBtn.render(scr,   { x: ox + 16, y: oy + 10, w: 12, h: 1 }, ring.isFocused('join'),   theme);

		if (errorLine) {
			scr.moveTo(ox, oy + 12);
			scr.write(colorFg(theme.error) + errorLine.slice(0, cw) + ansi.reset);
		}

		const fid = ring.current();
		const fi  = widgets.find(w => w.id === fid && w instanceof TextInput) as TextInput | undefined;
		if (fi) {
			const p = fi.getCursorPos(); scr.showCursor(p.x, p.y);
		}
	}

	setupView(scr, theme, render, ev => {
		if (ev.kind === 'key') {
			if (ev.key.ctrl && ev.key.name === 'c') {
				process.emit('SIGINT'); return;
			}
			if (ev.key.name === 'tab' && !ev.key.shift) {
				ring.next(); scr.markDirty(); return;
			}
			if (ev.key.name === 'tab' && ev.key.shift)  {
				ring.prev(); scr.markDirty(); return;
			}
			const fw = widgets.find(w => w.id === ring.current());
			if (!fw) return;
			if (fw.onKey(ev.key)) {
				scr.markDirty(); return;
			}
			if (ev.key.name === 'enter' && fw instanceof TextInput) {
				ring.next(); scr.markDirty();
			}
		} else if (ev.kind === 'mouse') {
			if (ev.mouse.type === 'click') {
				const w = clickHit(widgets, ev.mouse.x, ev.mouse.y);
				if (w) {
					ring.setById(w.id); w.onClick?.(); scr.markDirty();
				}
			}
		} else {
			const fw = widgets.find(w => w.id === ring.current());
			fw?.onPaste?.(ev.text); scr.markDirty();
		}
	});
}

// ─── renderWaiting ───────────────────────────────────────────────────────────

export function renderWaiting(
	scr: Screen,
	opts: { armoredInvite: string; roomId: string },
): void {
	disposeSidebar();
	_scrollView = null; _chatScreen = null; _chatRender = null; _errorDisplay = null;
	const config = readConfig();
	const theme  = loadTheme(config);

	const copyBtn     = new Button('copy',     'Copy Code', () => {
		void tryCopy(opts.armoredInvite, config.copyCmd).then(ok => {
			showModal(ok
				? { title: 'Copied',      body: 'Room code copied to your clipboard.' }
				: { title: 'Copy Failed', body: 'No clipboard manager found on this system.', accent: theme.error });
		});
	});
	const downloadBtn = new Button('download', 'Download', () => {
		const outPath = resolveUniqueFilename(join(process.cwd(), inviteFilename(opts.roomId)));
		void Bun.write(outPath, opts.armoredInvite).then(() => {
			showModal({ title: 'Invite Downloaded', body: resolve(outPath) });
		});
	});

	const ring    = new FocusRing();
	ring.register('copy'); ring.register('download');
	const widgets: Widget[] = [copyBtn, downloadBtn];

	const TABLE = [
		'┌────────┬───────────────────────┐',
		'│ cipher │  XChaCha20-Poly1305   │',
		'│ kem    │  ML-KEM-768           │',
		'│ format │  0x01                 │',
		'└────────┴───────────────────────┘',
	];

	function render() {
		scr.hideCursor();
		const ox     = Math.floor((scr.w - 52) / 2);
		const oy     = Math.max(1, Math.floor((scr.h - 11) / 2));

		scr.fillRect(1, 1, scr.w, scr.h, theme.bg);

		scr.moveTo(ox, oy);
		scr.write(colorFg(theme.fg) + ansi.bold + 'Room Code Generated Successfully' + ansi.reset);
		scr.moveTo(ox, oy + 1);
		scr.write(colorFg(theme.disabled) + 'Waiting for peer(s) to connect...' + ansi.reset);

		copyBtn.render(scr,     { x: ox,      y: oy + 3, w: 14, h: 1 }, ring.isFocused('copy'),     theme);
		downloadBtn.render(scr, { x: ox + 16, y: oy + 3, w: 14, h: 1 }, ring.isFocused('download'), theme);

		for (let i = 0; i < TABLE.length; i++) {
			scr.moveTo(ox, oy + 5 + i);
			scr.write(colorFg(theme.fg) + TABLE[i] + ansi.reset);
		}
	}

	setupView(scr, theme, render, ev => {
		if (ev.kind === 'key') {
			if (ev.key.ctrl && ev.key.name === 'c') {
				process.emit('SIGINT'); return;
			}
			if (ev.key.name === 'tab' && !ev.key.shift) {
				ring.next(); scr.markDirty(); return;
			}
			if (ev.key.name === 'tab' && ev.key.shift)  {
				ring.prev(); scr.markDirty(); return;
			}
			const fw = widgets.find(w => w.id === ring.current());
			if (fw?.onKey(ev.key)) scr.markDirty();
		} else if (ev.kind === 'mouse') {
			if (ev.mouse.type === 'click') {
				const w = clickHit(widgets, ev.mouse.x, ev.mouse.y);
				if (w) {
					ring.setById(w.id); w.onClick?.(); scr.markDirty();
				}
			}
		}
	});
}

// ─── renderJoin ──────────────────────────────────────────────────────────────

export function renderJoin(
	scr: Screen,
	opts: {
		prefillPath?: string
		username:    string
		onConnect:   (invite: InvitePayload) => void
	},
): void {
	disposeSidebar();
	_scrollView = null; _chatScreen = null; _chatRender = null; _errorDisplay = null;
	const theme = loadTheme(readConfig());

	let parsedInvite: InvitePayload | null = null;
	let errorLine  = '';
	let statusLine = '';

	const pathInput  = new TextInput('path', opts.prefillPath ?? '');
	const inviteArea = new TextArea('invite', '');
	const loadBtn    = new Button('load',    'Load',    () => {
		void doLoad();
	});
	const parseBtn   = new Button('parse',   'Parse',   () => {
		void doParse();
	});
	const connectBtn = new Button('connect', 'Connect', () => {
		if (!parsedInvite) return;
		statusLine = 'Connecting...';
		errorLine  = '';
		scr.markDirty();
		scr.beginRender(); scr.clear(); render(); scr.endRender();
		opts.onConnect(parsedInvite);
	}, true);

	const ring = new FocusRing();
	ring.register('path'); ring.register('load'); ring.register('invite');
	ring.register('parse'); ring.register('connect');
	const widgets: Widget[] = [pathInput, loadBtn, inviteArea, parseBtn, connectBtn];

	// surface doJoin system errors (server errors, room not found, etc.) into this view
	_errorDisplay = (msg: string) => {
		errorLine  = msg;
		statusLine = '';
		scr.markDirty();
		scr.beginRender(); scr.clear(); render(); scr.endRender();
	};

	function tryParse(text: string): boolean {
		try {
			parsedInvite    = parseArmoredInvite(text);
			connectBtn.disabled = false;
			statusLine      = `Server: ${parsedInvite.dns ?? 'localhost:3000'}  Room: ${parsedInvite.roomId}`;
			errorLine       = '';
			return true;
		} catch (e) {
			errorLine = `Parse error: ${e instanceof Error ? e.message : String(e)}`;
			return false;
		}
	}

	async function doLoad() {
		const p = pathInput.value.trim();
		if (!p) {
			errorLine = 'Enter a file path.'; scr.markDirty(); return;
		}
		try {
			const text = await Bun.file(p).text();
			tryParse(text);
		} catch (e) {
			errorLine = `Read error: ${e instanceof Error ? e.message : String(e)}`;
		}
		scr.markDirty();
		if (scr.needsRender()) {
			scr.beginRender(); scr.clear(); render(); scr.endRender();
		}
	}

	async function doParse() {
		const text = inviteArea.value.trim();
		if (!text) {
			errorLine = 'Paste invite text first.'; scr.markDirty(); return;
		}
		tryParse(text);
		scr.markDirty();
		if (scr.needsRender()) {
			scr.beginRender(); scr.clear(); render(); scr.endRender();
		}
	}

	function render() {
		scr.hideCursor();
		const cw = Math.min(scr.w - 8, 52);
		const ox = Math.floor((scr.w - cw) / 2);
		const oy = Math.max(1, Math.floor((scr.h - 20) / 2));

		scr.fillRect(1, 1, scr.w, scr.h, theme.bg);
		drawBanner(scr, oy);

		scr.moveTo(ox, oy);     scr.write(colorFg(theme.fg) + 'Path to .room file:' + ansi.reset);
		pathInput.render(scr,   { x: ox, y: oy + 1, w: cw,  h: 1 }, ring.isFocused('path'),    theme);
		loadBtn.render(scr,     { x: ox, y: oy + 3, w: 8,   h: 1 }, ring.isFocused('load'),    theme);

		if (errorLine) {
			scr.moveTo(ox, oy + 5);
			scr.write(colorFg(theme.error) + errorLine.slice(0, cw) + ansi.reset);
		}

		scr.moveTo(ox, oy + 7); scr.write(colorFg(theme.fg) + 'Or paste invite text:' + ansi.reset);
		inviteArea.render(scr,  { x: ox, y: oy + 8,  w: cw, h: 5 }, ring.isFocused('invite'),  theme);
		parseBtn.render(scr,    { x: ox, y: oy + 14, w: 9,  h: 1 }, ring.isFocused('parse'),   theme);
		connectBtn.render(scr,  { x: ox + 11, y: oy + 14, w: 11, h: 1 }, ring.isFocused('connect'), theme);

		if (statusLine) {
			scr.moveTo(ox, oy + 16);
			scr.write(colorFg(theme.disabled) + statusLine.slice(0, cw) + ansi.reset);
		}

		const fid = ring.current();
		const fi  = widgets.find(w => w.id === fid);
		if (fi instanceof TextInput) {
			const p = fi.getCursorPos(); scr.showCursor(p.x, p.y);
		} else if (fi instanceof TextArea) {
			const p = fi.getCursorPos(); scr.showCursor(p.x, p.y);
		}
	}

	// auto-load prefill path
	if (opts.prefillPath) {
		void Bun.file(opts.prefillPath).text().then(text => {
			tryParse(text);
		}).catch(e => {
			errorLine = `Read error: ${e instanceof Error ? e.message : String(e)}`;
		});
	}

	setupView(scr, theme, render, ev => {
		if (ev.kind === 'key') {
			if (ev.key.ctrl && ev.key.name === 'c') {
				process.emit('SIGINT'); return;
			}
			if (ev.key.name === 'tab' && !ev.key.shift) {
				ring.next(); scr.markDirty(); return;
			}
			if (ev.key.name === 'tab' && ev.key.shift)  {
				ring.prev(); scr.markDirty(); return;
			}
			const fw = widgets.find(w => w.id === ring.current());
			if (!fw) return;
			if (fw.onKey(ev.key)) {
				scr.markDirty(); return;
			}
			if (ev.key.name === 'enter' && fw instanceof TextInput) {
				ring.next(); scr.markDirty();
			}
		} else if (ev.kind === 'mouse') {
			if (ev.mouse.type === 'click') {
				const w = clickHit(widgets, ev.mouse.x, ev.mouse.y);
				if (w) {
					ring.setById(w.id); w.onClick?.(); scr.markDirty();
				}
			}
		} else {
			const fw = widgets.find(w => w.id === ring.current());
			fw?.onPaste?.(ev.text); scr.markDirty();
		}
	});
}

// ─── renderChat ──────────────────────────────────────────────────────────────

interface PeerInfo {
	ek:        string
	ratchetEk: string
	colorIdx:  number
}

export function renderChat(
	scr: Screen,
	opts: {
		username:        string
		peers:           Map<string, PeerInfo>
		onSend:          (text: string) => void
		onFile:          (filePath: string) => Promise<void>
		onRotate:        () => void
		getFingerprints: () => { local: FingerprintSurface; peers: { username: string; fingerprint: FingerprintSurface }[] }
	},
): void {
	_chatScreen = scr;
	const cfg   = readConfig();
	const theme = loadTheme(cfg);

	const scrollView = new ScrollView('msgArea');
	_scrollView = scrollView;

	const lblSend    = cfg.icons?.send    ?? '>';
	const lblAttach  = cfg.icons?.attach  ?? '+';
	const lblRatchet = cfg.icons?.ratchet ?? 'R';

	const chatInput = new TextInput('chatInput', '');
	const sendBtn   = new Button('sendBtn',   lblSend,    () => doSend());
	const attachBtn = new Button('attachBtn', lblAttach,  () => enterPicking());
	const rotateBtn = new Button('rotateBtn', lblRatchet, () => opts.onRotate());

	// Sidebar mirrors the web's two-mode pane. Hidden by default; toggled with
	// Ctrl+E (event log) and Ctrl+V (verify). Width is read from / persisted to
	// the user's config.
	disposeSidebar();
	const sidebar = new Sidebar(readSidebarWidth(cfg), opts.getFingerprints, opts.username);
	_sidebar = sidebar;
	sidebar.attach(() => {
		scr.markDirty();
		chatDoRender();
	});

	const ring = new FocusRing();
	_focusRing = ring;
	function rebuildRing() {
		ring.clear();
		if (picking) {
			ring.register('pathInput'); ring.register('cancelBtn');
		} else {
			ring.register('chatInput'); ring.register('sendBtn');
			ring.register('attachBtn'); ring.register('rotateBtn'); ring.register('msgArea');
			if (sidebar.isOpen() && sidebarLayoutWidth() > 0) ring.register('sidebar');
		}
	}

	// Landing on msgArea arms the attachment cursor; landing anywhere else
	// (input bar, action buttons, file picker) re-arms auto-scroll so the
	// view snaps to the latest line. Sidebar focus stays parked.
	function afterFocusChange() {
		const fid = ring.current();
		if (fid === 'msgArea')      scrollView.selectLatest();
		else if (fid !== 'sidebar') scrollView.enableAutoScroll();
	}

	const baseWidgets: Widget[] = [chatInput, sendBtn, rotateBtn, attachBtn, scrollView, sidebar];

	// FilePicker state
	let picking        = false;
	let pathInput: TextInput | null = null;
	let cancelBtn: Button | null    = null;
	let tabMatches:  string[] = [];
	let tabIdx         = -1;
	let tabCycled      = '';

	rebuildRing();

	function showHelp(): void {
		const text = [
			'available commands:',
			'  /exit (/quit, /q, /part)  quit covcom',
			'  /ratchet                  rotate keys (Ctrl+R)',
			'  /events                   toggle event log (Ctrl+E)',
			'  /verify                   toggle verify pane (Ctrl+V)',
			'  /help (/?)                show this list',
		].join('\n');
		appendMessage({ sender: 'system', text, isSelf: false, senderIndex: 7 });
	}

	const commands: Record<string, () => void> = {
		exit: () => {
			process.emit('SIGINT');
		},
		quit: () => {
			process.emit('SIGINT');
		},
		q: () => {
			process.emit('SIGINT');
		},
		part: () => {
			process.emit('SIGINT');
		},
		ratchet: () => opts.onRotate(),
		events: () => toggleMode('event-log'),
		verify: () => toggleMode('verify'),
		help: () => showHelp(),
		'?': () => showHelp(),
	};

	function dispatchCommand(raw: string): void {
		const name = raw.slice(1).split(/\s+/)[0].toLowerCase();
		const fn   = commands[name];
		if (fn) {
			fn(); return;
		}
		appendMessage({
			sender: 'system',
			text: `unknown command: ${raw} — type /help for a list`,
			isSelf: false,
			senderIndex: 7,
		});
	}

	function doSend() {
		const text = chatInput.value.trim();
		if (!text) return;
		chatInput.setValue('');
		if (text.startsWith('/')) {
			dispatchCommand(text); return;
		}
		opts.onSend(text);
	}

	function enterPicking() {
		picking    = true;
		pathInput  = new TextInput('pathInput', '');
		cancelBtn  = new Button('cancelBtn', 'x', () => exitPicking());
		tabMatches = []; tabIdx = -1; tabCycled = '';

		rebuildRing();
		scr.markDirty();
	}

	function exitPicking() {
		picking   = false;
		pathInput = null; cancelBtn = null;

		rebuildRing();
		scr.markDirty();
	}

	function doTabComplete() {
		if (!pathInput) return;
		const val = pathInput.value;
		if (val !== tabCycled) {
			tabMatches = getCompletions(val);
			tabIdx     = -1;
		}
		if (!tabMatches.length) return;
		tabIdx        = (tabIdx + 1) % tabMatches.length;
		tabCycled     = tabMatches[tabIdx];
		pathInput.value  = tabCycled;
		pathInput.cursor = tabCycled.length;
	}

	// Compute the actual sidebar column width given the current screen size.
	// Returns 0 when the sidebar should not be drawn (closed, or terminal too
	// narrow). Reserves 1 col for the separator.
	function sidebarLayoutWidth(): number {
		if (!sidebar.isOpen()) return 0;
		if (scr.w < SIDEBAR_MIN_COLS) return 0;
		const w = Math.floor(scr.w * sidebar.width / 100);
		return Math.max(10, Math.min(w, scr.w - 24));
	}

	function toggleMode(target: SidebarMode) {
		if (target === null) return;
		const prev = sidebar.mode;
		if (prev === target)      sidebar.setMode(null);
		else                      sidebar.setMode(target);
		rebuildRing();
		// When opening from closed, jump focus to the sidebar so keyboard nav works.
		if (prev === null && sidebar.mode !== null) ring.setById('sidebar');
		// When closing, drop focus back onto chatInput.
		if (sidebar.mode === null) ring.setById('chatInput');
		afterFocusChange();
		scr.markDirty();
	}

	function render() {
		scr.hideCursor();
		const sideW   = sidebarLayoutWidth();
		const sideOn  = sideW > 0;
		const chatW   = sideOn ? scr.w - sideW - 1 : scr.w;
		const sepY    = scr.h - 1;
		const barY    = scr.h;
		const msgH    = scr.h - 2;

		scrollView.render(scr, { x: 1, y: 1, w: chatW, h: msgH }, ring.isFocused('msgArea'), theme);

		// chat-side separator and input bar
		scr.fillRect(1, sepY, chatW, 1, theme.barBg);
		scr.fillRect(1, barY, chatW, 1, theme.barBg);

		if (picking && pathInput && cancelBtn) {
			const wIcon  = [...lblAttach].length;
			const iconX  = 2;
			const inputX = iconX + wIcon + 1;
			const inputW = Math.max(1, chatW - 3 - inputX);

			scr.moveTo(iconX, barY);
			scr.write(colorBg(theme.barBg) + colorFg(theme.attachBg) + ansi.bold + lblAttach + ansi.reset);

			pathInput.render(scr, { x: inputX,    y: barY, w: inputW, h: 1 }, ring.isFocused('pathInput'), theme);
			cancelBtn.render(scr, { x: chatW - 3, y: barY, w: 3,      h: 1 }, ring.isFocused('cancelBtn'), theme);
		} else {
			const wSend    = [...lblSend].length    + 2;
			const wAttach  = [...lblAttach].length  + 2;
			const wRatchet = [...lblRatchet].length + 2;
			const xRatchet = chatW - wRatchet;
			const xAttach  = xRatchet - wAttach;
			const xSend    = xAttach - wSend;
			const inputW   = Math.max(1, xSend - 3);

			chatInput.render(scr, { x: 2,        y: barY, w: inputW,   h: 1 }, ring.isFocused('chatInput'), theme);
			sendBtn.render(scr,   { x: xSend,    y: barY, w: wSend,    h: 1 }, ring.isFocused('sendBtn'),   theme);
			attachBtn.render(scr, { x: xAttach,  y: barY, w: wAttach,  h: 1 }, ring.isFocused('attachBtn'), theme);
			rotateBtn.render(scr, { x: xRatchet, y: barY, w: wRatchet, h: 1 }, ring.isFocused('rotateBtn'), theme);
		}

		if (sideOn) {
			// vertical separator column
			scr.fillRect(chatW + 1, 1, 1, scr.h, theme.barBg);
			sidebar.render(scr, { x: chatW + 2, y: 1, w: sideW, h: scr.h }, ring.isFocused('sidebar'), theme);
		}

		// cursor
		const fid = ring.current();
		if (picking && pathInput && fid === 'pathInput') {
			const p = pathInput.getCursorPos(); scr.showCursor(p.x, p.y);
		} else if (!picking && fid === 'chatInput') {
			const p = chatInput.getCursorPos(); scr.showCursor(p.x, p.y);
		}
	}

	_chatRender = render;

	setupView(scr, theme, render, ev => {
		if (ev.kind === 'key') {
			const key = ev.key;
			if (key.ctrl && key.name === 'c') {
				process.emit('SIGINT'); return;
			}

			if (picking && pathInput) {
				if (key.name === 'escape') {
					exitPicking(); return;
				}
				if (key.name === 'enter') {
					const raw = pathInput.value.trim();
					if (!raw) {
						exitPicking(); return;
					}
					const p = resolve(raw);
					exitPicking();
					void opts.onFile(p);
					return;
				}
				if (key.name === 'tab' && !key.shift) {
					doTabComplete(); scr.markDirty(); return;
				}
				if (key.name === 'tab' && key.shift) {
					ring.prev(); scr.markDirty(); return;
				}
				const fw = picking
					? ([pathInput, cancelBtn] as (Widget | null)[]).filter((w): w is Widget => w !== null).find(w => w.id === ring.current())
					: null;
				if (fw?.onKey(key)) {
					scr.markDirty(); return;
				}
				return;
			}

			// normal chat mode
			if (key.ctrl && key.name === 'r') {
				opts.onRotate(); return;
			}
			if (key.ctrl && key.name === 'e') {
				toggleMode('event-log'); return;
			}
			if (key.ctrl && key.name === 'v') {
				toggleMode('verify'); return;
			}
			if (key.name === 'escape' && sidebar.isOpen() && ring.isFocused('sidebar')) {
				sidebar.setMode(null);
				rebuildRing();
				ring.setById('chatInput');
				afterFocusChange();
				scr.markDirty(); return;
			}
			if (key.name === 'escape' && ring.isFocused('msgArea')) {
				ring.setById('chatInput');
				afterFocusChange();
				scr.markDirty(); return;
			}
			// Width-stepping is only active while focus is on the sidebar so the
			// chat input still accepts '+'/'-' as normal characters.
			if (ring.isFocused('sidebar') && key.ch === '+') {
				writeSidebarWidth(sidebar.stepWidth(+1));
				scr.markDirty(); return;
			}
			if (ring.isFocused('sidebar') && key.ch === '-') {
				writeSidebarWidth(sidebar.stepWidth(-1));
				scr.markDirty(); return;
			}
			if (key.name === 'tab' && !key.shift) {
				ring.next();
				afterFocusChange();
				scr.markDirty(); return;
			}
			if (key.name === 'tab' && key.shift)  {
				ring.prev();
				afterFocusChange();
				scr.markDirty(); return;
			}

			const fw = baseWidgets.find(w => w.id === ring.current());
			if (!fw) return;
			if (fw.id === 'chatInput' && key.name === 'enter') {
				doSend(); scr.markDirty(); return;
			}
			if (fw.onKey(key)) {
				scr.markDirty(); return;
			}

		} else if (ev.kind === 'mouse') {
			const m = ev.mouse;
			if (m.type === 'scroll') {
				// scroll over msgArea regardless of focus
				if (m.x >= scrollView.rect.x && m.x < scrollView.rect.x + scrollView.rect.w &&
				    m.y >= scrollView.rect.y && m.y < scrollView.rect.y + scrollView.rect.h) {
					if (m.button === 64) scrollView.scrollUp(3);
					else                  scrollView.scrollDown(3);
					scr.markDirty();
				} else if (sidebar.isOpen() &&
				    m.x >= sidebar.rect.x && m.x < sidebar.rect.x + sidebar.rect.w &&
				    m.y >= sidebar.rect.y && m.y < sidebar.rect.y + sidebar.rect.h) {
					sidebar.scrollByLines(m.button === 64 ? -3 : +3);
					scr.markDirty();
				}
				return;
			}
			if (m.type === 'click') {
				// check attachment chip hit
				const hit = scrollView.hitTest(m.x, m.y);
				if (hit?.attachment?.saved) {
					const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
					Bun.spawn([opener, hit.attachment.saved]);
					return;
				}
				const aw = picking
					? ([pathInput, cancelBtn] as (Widget | null)[]).filter((w): w is Widget => w !== null).find(w => m.x >= w.rect.x && m.x < w.rect.x + w.rect.w && m.y >= w.rect.y && m.y < w.rect.y + w.rect.h)
					: clickHit(baseWidgets, m.x, m.y);
				if (aw) {
					ring.setById(aw.id);
					afterFocusChange();
					aw.onClick?.();
					scr.markDirty();
				}
			}
		} else {
			// paste
			if (picking && pathInput && ring.isFocused('pathInput')) {
				pathInput.onPaste(ev.text); scr.markDirty();
			} else if (!picking && ring.isFocused('chatInput')) {
				chatInput.onPaste(ev.text); scr.markDirty();
			}
		}
	});
}

// ─── appendMessage / appendFile ───────────────────────────────────────────────

export function appendMessage(msg: {
	sender:      string
	text:        string
	isSelf:      boolean
	senderIndex: number
}): void {
	if (!_scrollView || !_chatScreen) {
		// not in chat; route system messages (server errors, etc.) to active view
		if (msg.sender === 'system' && _errorDisplay) _errorDisplay(msg.text);
		return;
	}
	// Snap to bottom when the user is acting on the input bar (chat input,
	// send/rotate/attach, or the file picker). Reading backlog (msgArea) or
	// the sidebar (verify / event log) preserves their scroll position.
	const fid = _focusRing?.current() ?? '';
	if (fid !== 'msgArea' && fid !== 'sidebar') _scrollView.enableAutoScroll();
	_scrollView.addMessage(msg);
	_chatScreen.markDirty();
	chatDoRender();
}

export function appendFile(msg: {
	sender:      string
	filename:    string
	size:        number
	mime:        string
	isSelf:      boolean
	senderIndex: number
	saved?:      string
	download?:   () => Promise<string>
}): void {
	if (!_scrollView || !_chatScreen) return;
	const fid = _focusRing?.current() ?? '';
	if (fid !== 'msgArea' && fid !== 'sidebar') _scrollView.enableAutoScroll();
	_scrollView.addFile(msg);
	_chatScreen.markDirty();
	chatDoRender();
}
