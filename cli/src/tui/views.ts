import { join, resolve } from 'path';
import { readdirSync, existsSync, statSync } from 'fs';
import { parseArmoredInvite, inviteFilename, CRYPTO_TABLE, qrMatrix } from '@covcom/lib';
import type { InvitePayload, FingerprintSurface } from '@covcom/lib';
import { Screen, Theme, ColorValue, loadTheme, colorFg, colorBg, ansi } from './screen.js';
import { parseInput, InputEvent } from './keys.js';
import { FocusRing } from './focus.js';
import { TextInput, TextArea, Button, ScrollView, Sidebar, Widget, drawModal } from './widgets.js';
import { qrHalfBlock } from './qr.js';
import type { SidebarMode, ModalOpts } from './widgets.js';
import { readConfig, readSidebarWidth, writeSidebarWidth, SIDEBAR_MIN_COLS } from '../config.js';
import type { Config } from '../config.js';
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

// ─── chat layout decision ────────────────────────────────────────────────────

export type ChatLayoutMode = 'chat' | 'side' | 'full';
export interface ChatLayout { mode: ChatLayoutMode; sideW: number; chatW: number }

// Layout from sidebar state + terminal width. in 'full' (terminal too narrow)
// the sidebar spans the whole screen and chat is hidden
export function chatLayout(open: boolean, cols: number, sidebarPct: number): ChatLayout {
	if (!open)                   return { mode: 'chat', sideW: 0,    chatW: cols };
	if (cols < SIDEBAR_MIN_COLS) return { mode: 'full', sideW: cols, chatW: 0    };
	const w = Math.max(10, Math.min(Math.floor(cols * sidebarPct / 100), cols - 24));
	return { mode: 'side', sideW: w, chatW: cols - w - 1 };
}

// Focus-ring membership for a layout. `picking` (file picker) takes precedence.
// In 'full' only the sidebar is reachable; chat widgets are hidden, thus skipped
export function chatFocusIds(mode: ChatLayoutMode, picking: boolean): string[] {
	if (picking)         return ['pathInput', 'cancelBtn'];
	if (mode === 'full') return ['sidebar'];
	const ids = ['chatInput', 'sendBtn', 'attachBtn', 'rotateBtn', 'msgArea'];
	if (mode === 'side') ids.push('sidebar');
	return ids;
}

export interface KeyHint { key: string; label: string; icon?: string }

// The modal keys-display units, in render order. The icon comes straight from
// the raw config (no defaults): unset renders nothing and skips its bookend
// space, so a config without these glyphs shows just the key + label.
export function keyHints(cfg: Config): KeyHint[] {
	const ic = (v?: string): string | undefined => {
		const t = (v ?? '').trim();
		return t === '' ? undefined : t;
	};
	return [
		{ key: 'R',   label: 'ratchet',         icon: ic(cfg.icons?.ratchet) },
		{ key: 'E',   label: 'events',          icon: ic(cfg.icons?.events)  },
		{ key: 'V',   label: 'verify',          icon: ic(cfg.icons?.verify)  },
		{ key: 'ESC', label: 'return to chat',  icon: ic(cfg.icons?.escape)  },
	];
}

function capFirst(s: string): string {
	return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

// Paint the modal keys-display across the input bar (single row). Colors follow
// the bar palette: btnBg per unit, barBtnFg for icon/label, focus colors for the
// ` KEY ` block, barBg for the single space between units. The icon (and its
// trailing space) is omitted when a hint carries none.
function renderKeysBar(scr: Screen, x: number, y: number, theme: Theme, hints: KeyHint[]): void {
	const btn  = colorBg(theme.barBtnBg)      + colorFg(theme.barBtnFg);
	const keyc = colorBg(theme.barBtnFocusBg) + colorFg(theme.barBtnFocusFg);
	const gap  = colorBg(theme.barBg);
	let out = '';
	hints.forEach((h, i) => {
		if (i > 0) out += gap + ' ';
		const label = capFirst(h.label);
		out += btn + ' ';
		if (h.icon) out += h.icon + ' ';
		out += keyc + ' ' + h.key + ' ' + btn + ' ';
		out += ansi.bold + label[0] + ansi.reset + btn + label.slice(1) + ' ';
	});
	scr.moveTo(x, y);
	scr.write(out + ansi.reset);
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
let _quitConfirm = false;
let _activeView: { gen: number; scr: Screen; render: () => void; theme: Theme } | null = null;

function doQuit(): void {
	process.emit('SIGINT');
}

// Ctrl+C guard: first press shows a confirm modal, second press exits.
function requestQuit(): void {
	if (_quitConfirm) {
		doQuit(); return;
	}
	_quitConfirm = true;
	showModal({
		title: 'quit covcom?',
		body: 'press ctrl+c again to exit or any key to cancel',
	});
}

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
	_quitConfirm = false;
	_activeView = { gen, scr, render: renderAll, theme };

	const handle = (ev: InputEvent) => {
		if (_modal) {
			if (ev.kind === 'key') {
				if (ev.key.ctrl && ev.key.name === 'c') {
					requestQuit(); return;
				}
				_modal = null; _quitConfirm = false; scr.markDirty(); return;
			}
			if (ev.kind === 'mouse' && ev.mouse.type === 'click') {
				_modal = null; _quitConfirm = false; scr.markDirty(); return;
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

	// Re-measure before the first paint: at process start stdout may not yet
	// report a size, leaving the screen on its 80x24 defaults until the first
	// resize event. Width-capped views hide that, but the wide invite QR gets
	// gated out (qrW > 80) and only appears once a resize delivers real dims.
	scr.measure();
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
		config:        { username?: string }
		onCreateClick: (username: string) => void
		onJoinClick:   (username: string) => void
	},
): void {
	disposeSidebar();
	_scrollView = null; _chatScreen = null; _chatRender = null; _errorDisplay = null;
	const theme = loadTheme(readConfig());

	let errorLine = '';

	const usernameInput = new TextInput('username', opts.config.username ?? '');
	const createBtn     = new Button('create', 'Create Room', () => {
		const username = usernameInput.value.trim();
		if (!username) {
			errorLine = 'Username is required'; scr.markDirty(); return;
		}
		opts.onCreateClick(username);
	});
	const joinBtn = new Button('join', 'Join Room', () => {
		const username = usernameInput.value.trim();
		if (!username) {
			errorLine = 'Username is required'; scr.markDirty(); return;
		}
		opts.onJoinClick(username);
	});

	const ring    = new FocusRing();
	ring.register('username'); ring.register('create'); ring.register('join');
	const widgets: Widget[] = [usernameInput, createBtn, joinBtn];

	function render() {
		scr.hideCursor();
		const cw = Math.min(scr.w - 8, 44);
		const ox = Math.floor((scr.w - cw) / 2);
		const oy = Math.max(1, Math.floor((scr.h - 8) / 2));

		scr.fillRect(1, 1, scr.w, scr.h, theme.bg);
		drawBanner(scr, oy);

		scr.moveTo(ox, oy); scr.write(colorFg(theme.fg) + 'Username:' + ansi.reset);
		usernameInput.render(scr, { x: ox, y: oy + 1, w: cw, h: 1 }, ring.isFocused('username'), theme);

		createBtn.render(scr, { x: ox,      y: oy + 3, w: 14, h: 1 }, ring.isFocused('create'), theme);
		joinBtn.render(scr,   { x: ox + 16, y: oy + 3, w: 12, h: 1 }, ring.isFocused('join'),   theme);

		if (errorLine) {
			scr.moveTo(ox, oy + 5);
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
				requestQuit(); return;
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

// ─── renderCreate ──────────────────────────────────────────────────────────────

export function renderCreate(
	scr: Screen,
	opts: {
		config:   { server?: string; username?: string }
		username: string
		onCreate: (server: string, username: string, adminToken?: string) => void
		onCancel: (username: string) => void
	},
): void {
	disposeSidebar();
	_scrollView = null; _chatScreen = null; _chatRender = null; _errorDisplay = null;
	const theme = loadTheme(readConfig());

	let errorLine = '';
	let showToken = false;

	const usernameInput = new TextInput('username',  opts.username || (opts.config.username ?? ''));
	const serverInput   = new TextInput('server',    opts.config.server ?? '');
	const tokenInput    = new TextInput('authToken', '', true);  // masked, like the web type="password"
	const advancedBtn   = new Button('advanced', 'Advanced >', () => {
		showToken = !showToken;
		buildRing();
		ring.setById('advanced');
		scr.markDirty();
	});
	const createBtn = new Button('create', 'Create Room', () => {
		const server   = serverInput.value.trim();
		const username = usernameInput.value.trim();
		if (!server || !username) {
			errorLine = 'Server and username are required'; scr.markDirty(); return;
		}
		errorLine = '';
		opts.onCreate(server, username, tokenInput.value.trim() || undefined);
	});
	const cancelBtn = new Button('cancel', 'Cancel', () => opts.onCancel(usernameInput.value.trim()));

	// Token row joins the ring only while expanded, so Tab never lands on a
	// hidden field.
	const ring = new FocusRing();
	function buildRing() {
		ring.clear();
		ring.register('username'); ring.register('server'); ring.register('advanced');
		if (showToken) ring.register('authToken');
		ring.register('create'); ring.register('cancel');
	}
	function widgetList(): Widget[] {
		const ws: Widget[] = [usernameInput, serverInput, advancedBtn];
		if (showToken) ws.push(tokenInput);
		ws.push(createBtn, cancelBtn);
		return ws;
	}
	buildRing();

	// surface doCreate system errors (server error, connection failed, version
	// mismatch) inline so the user stays here with their entries intact.
	_errorDisplay = (msg: string) => {
		errorLine = msg;
		scr.markDirty();
		scr.beginRender(); scr.clear(); render(); scr.endRender();
	};

	function render() {
		scr.hideCursor();
		const cw = Math.min(scr.w - 8, 44);
		const ox = Math.floor((scr.w - cw) / 2);
		const oy = Math.max(1, Math.floor((scr.h - 16) / 2));

		scr.fillRect(1, 1, scr.w, scr.h, theme.bg);
		drawBanner(scr, oy);

		scr.moveTo(ox, oy); scr.write(colorFg(theme.fg) + 'Username:' + ansi.reset);
		usernameInput.render(scr, { x: ox, y: oy + 1, w: cw, h: 1 }, ring.isFocused('username'), theme);

		scr.moveTo(ox, oy + 3); scr.write(colorFg(theme.fg) + 'Server DNS:' + ansi.reset);
		serverInput.render(scr, { x: ox, y: oy + 4, w: cw, h: 1 }, ring.isFocused('server'), theme);

		advancedBtn.render(scr, { x: ox, y: oy + 6, w: 14, h: 1 }, ring.isFocused('advanced'), theme);

		let row = oy + 8;
		if (showToken) {
			scr.moveTo(ox, oy + 8); scr.write(colorFg(theme.fg) + 'Server Password (optional):' + ansi.reset);
			tokenInput.render(scr, { x: ox, y: oy + 9, w: cw, h: 1 }, ring.isFocused('authToken'), theme);
			row = oy + 11;
		}

		createBtn.render(scr, { x: ox,      y: row, w: 14, h: 1 }, ring.isFocused('create'), theme);
		cancelBtn.render(scr, { x: ox + 16, y: row, w: 10, h: 1 }, ring.isFocused('cancel'), theme);

		if (errorLine) {
			scr.moveTo(ox, row + 2);
			scr.write(colorFg(theme.error) + errorLine.slice(0, cw) + ansi.reset);
		}

		const fid = ring.current();
		const fi  = widgetList().find(w => w.id === fid && w instanceof TextInput) as TextInput | undefined;
		if (fi) {
			const p = fi.getCursorPos(); scr.showCursor(p.x, p.y);
		}
	}

	setupView(scr, theme, render, ev => {
		if (ev.kind === 'key') {
			if (ev.key.ctrl && ev.key.name === 'c') {
				requestQuit(); return;
			}
			if (ev.key.name === 'tab' && !ev.key.shift) {
				ring.next(); scr.markDirty(); return;
			}
			if (ev.key.name === 'tab' && ev.key.shift)  {
				ring.prev(); scr.markDirty(); return;
			}
			const fw = widgetList().find(w => w.id === ring.current());
			if (!fw) return;
			if (fw.onKey(ev.key)) {
				scr.markDirty(); return;
			}
			if (ev.key.name === 'enter' && fw instanceof TextInput) {
				ring.next(); scr.markDirty();
			}
		} else if (ev.kind === 'mouse') {
			if (ev.mouse.type === 'click') {
				const w = clickHit(widgetList(), ev.mouse.x, ev.mouse.y);
				if (w) {
					ring.setById(w.id); w.onClick?.(); scr.markDirty();
				}
			}
		} else {
			const fw = widgetList().find(w => w.id === ring.current());
			fw?.onPaste?.(ev.text); scr.markDirty();
		}
	});
}

// ─── renderWaiting ───────────────────────────────────────────────────────────

export function renderWaiting(
	scr: Screen,
	opts: { armoredInvite: string; roomId: string; onCancel: () => void },
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

	const cancelBtn = new Button('cancel', 'Cancel', () => opts.onCancel());

	const ring    = new FocusRing();
	ring.register('copy'); ring.register('download'); ring.register('cancel');
	const widgets: Widget[] = [copyBtn, downloadBtn, cancelBtn];

	// Rows from lib's CRYPTO_TABLE (shared with the web client so the two can't
	// drift). LCOL/RCOL are the inner cell widths, sized to the longest label and
	// value; the box-drawing chars are the only ones in the codebase, per
	// PROTOCOL.md, so they stay confined here.
	const LCOL = 23;
	const RCOL = 20;
	const bar = (l: string, m: string, r: string): string =>
		l + '─'.repeat(LCOL) + m + '─'.repeat(RCOL) + r;
	const cell = (k: string, v: string): string =>
		'│' + (' ' + k).padEnd(LCOL) + '│' + (' ' + v).padEnd(RCOL) + '│';
	const TABLE = [
		bar('┌', '┬', '┐'),
		cell('COMPONENT', 'PRIMITIVE'),
		bar('├', '┼', '┤'),
		...CRYPTO_TABLE.map(([k, v]) => cell(k, v)),
		bar('└', '┴', '┘'),
	];

	// A scannable QR of the same armored invite the web client encodes. Each
	// text row packs two module rows via half-block glyphs. Built once; stays
	// null (and is simply omitted) when the invite is too large to encode,
	// mirroring the web client hiding its canvas on error.
	let qrRows: string[] | null;
	try {
		qrRows = qrHalfBlock(qrMatrix(opts.armoredInvite));
	} catch {
		qrRows = null;
	}

	function render() {
		scr.hideCursor();
		const tableW = TABLE[0].length;
		const ox  = Math.floor((scr.w - tableW) / 2);
		const qrH = qrRows ? qrRows.length : 0;
		const qrW = qrRows ? qrRows[0].length : 0;

		// The QR sits above the table (one blank row between). Center the whole
		// block including it; fall back to the table-only layout when the QR can't
		// fit the terminal.
		let showQr   = qrRows !== null && qrW <= scr.w;
		const blockH = showQr ? 5 + qrH + 1 + TABLE.length : 5 + TABLE.length;
		let oy       = Math.max(1, Math.floor((scr.h - blockH) / 2));
		if (showQr && oy + blockH - 1 > scr.h) {
			showQr = false;
			oy     = Math.max(1, Math.floor((scr.h - (5 + TABLE.length)) / 2));
		}

		scr.fillRect(1, 1, scr.w, scr.h, theme.bg);

		scr.moveTo(ox, oy);
		scr.write(colorFg(theme.fg) + ansi.bold + 'Room Code Generated Successfully' + ansi.reset);
		scr.moveTo(ox, oy + 1);
		scr.write(colorFg(theme.disabled) + 'Waiting for peer(s) to connect...' + ansi.reset);

		copyBtn.render(scr,     { x: ox,      y: oy + 3, w: 14, h: 1 }, ring.isFocused('copy'),     theme);
		downloadBtn.render(scr, { x: ox + 16, y: oy + 3, w: 14, h: 1 }, ring.isFocused('download'), theme);
		cancelBtn.render(scr,   { x: ox + 32, y: oy + 3, w: 10, h: 1 }, ring.isFocused('cancel'),   theme);

		// Forced black-on-white regardless of theme, for scanner contrast.
		if (showQr && qrRows) {
			const qx = Math.floor((scr.w - qrW) / 2);
			for (let i = 0; i < qrRows.length; i++) {
				scr.moveTo(qx, oy + 5 + i);
				scr.write(ansi.bgHex('#ffffff') + ansi.fgHex('#000000') + qrRows[i] + ansi.reset);
			}
		}

		const tableTop = showQr ? 5 + qrH + 1 : 5;
		for (let i = 0; i < TABLE.length; i++) {
			scr.moveTo(ox, oy + tableTop + i);
			scr.write(colorFg(theme.fg) + TABLE[i] + ansi.reset);
		}
	}

	setupView(scr, theme, render, ev => {
		if (ev.kind === 'key') {
			if (ev.key.ctrl && ev.key.name === 'c') {
				requestQuit(); return;
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
		onConnect:   (invite: InvitePayload, username: string) => void
		onCancel:    (username: string) => void
	},
): void {
	disposeSidebar();
	_scrollView = null; _chatScreen = null; _chatRender = null; _errorDisplay = null;
	const theme = loadTheme(readConfig());

	let errorLine = '';

	const usernameInput = new TextInput('username', opts.username);
	const pathInput     = new TextInput('path', opts.prefillPath ?? '');
	const inviteArea    = new TextArea('invite', '');
	const browseBtn     = new Button('browse', 'Browse', () => {
		void doBrowse();
	});
	const joinBtn       = new Button('join', 'Join Room', () => {
		const username = usernameInput.value.trim();
		if (!username) {
			errorLine = 'Username is required'; scr.markDirty(); return;
		}
		const text = inviteArea.value.trim();
		if (!text) {
			errorLine = 'Paste an invite or load a .room file first.'; scr.markDirty(); return;
		}
		let invite: InvitePayload;
		try {
			invite = parseArmoredInvite(text);
		} catch (e) {
			errorLine = `Parse error: ${e instanceof Error ? e.message : String(e)}`;
			scr.markDirty(); return;
		}
		errorLine = '';
		opts.onConnect(invite, username);
	});
	const cancelBtn = new Button('cancel', 'Cancel', () => opts.onCancel(usernameInput.value.trim()));

	const ring = new FocusRing();
	ring.register('username'); ring.register('path'); ring.register('browse');
	ring.register('invite'); ring.register('join'); ring.register('cancel');
	const widgets: Widget[] = [usernameInput, pathInput, browseBtn, inviteArea, joinBtn, cancelBtn];

	// surface doJoin system errors (server errors, room not found, etc.) into this view
	_errorDisplay = (msg: string) => {
		errorLine = msg;
		scr.markDirty();
		scr.beginRender(); scr.clear(); render(); scr.endRender();
	};

	// Browse reads the file at the path into the textarea, the single source
	// Join Room parses.
	async function doBrowse() {
		const p = pathInput.value.trim();
		if (!p) {
			errorLine = 'Enter a file path.'; scr.markDirty(); return;
		}
		try {
			inviteArea.setValue(await Bun.file(p).text());
			errorLine = '';
		} catch (e) {
			errorLine = `Read error: ${e instanceof Error ? e.message : String(e)}`;
		}
		scr.markDirty();
		if (scr.needsRender()) {
			scr.beginRender(); scr.clear(); render(); scr.endRender();
		}
	}

	function render() {
		scr.hideCursor();
		const cw = Math.min(scr.w - 8, 52);
		const ox = Math.floor((scr.w - cw) / 2);
		const oy = Math.max(1, Math.floor((scr.h - 22) / 2));

		scr.fillRect(1, 1, scr.w, scr.h, theme.bg);
		drawBanner(scr, oy);

		scr.moveTo(ox, oy); scr.write(colorFg(theme.fg) + 'Username:' + ansi.reset);
		usernameInput.render(scr, { x: ox, y: oy + 1, w: cw, h: 1 }, ring.isFocused('username'), theme);

		scr.moveTo(ox, oy + 3); scr.write(colorFg(theme.fg) + 'Path to .room file:' + ansi.reset);
		pathInput.render(scr,   { x: ox, y: oy + 4, w: cw, h: 1 }, ring.isFocused('path'),   theme);
		browseBtn.render(scr,   { x: ox, y: oy + 6, w: 10, h: 1 }, ring.isFocused('browse'), theme);

		scr.moveTo(ox, oy + 8); scr.write(colorFg(theme.fg) + 'Or paste invite text:' + ansi.reset);
		inviteArea.render(scr,  { x: ox, y: oy + 9, w: cw, h: 5 }, ring.isFocused('invite'), theme);

		if (errorLine) {
			scr.moveTo(ox, oy + 15);
			scr.write(colorFg(theme.error) + errorLine.slice(0, cw) + ansi.reset);
		}

		joinBtn.render(scr,   { x: ox,      y: oy + 17, w: 12, h: 1 }, ring.isFocused('join'),   theme);
		cancelBtn.render(scr, { x: ox + 14, y: oy + 17, w: 10, h: 1 }, ring.isFocused('cancel'), theme);

		const fid = ring.current();
		const fi  = widgets.find(w => w.id === fid);
		if (fi instanceof TextInput) {
			const p = fi.getCursorPos(); scr.showCursor(p.x, p.y);
		} else if (fi instanceof TextArea) {
			const p = fi.getCursorPos(); scr.showCursor(p.x, p.y);
		}
	}

	// auto-load prefill path into the textarea
	if (opts.prefillPath) {
		void Bun.file(opts.prefillPath).text().then(text => {
			inviteArea.setValue(text);
		}).catch(e => {
			errorLine = `Read error: ${e instanceof Error ? e.message : String(e)}`;
		});
	}

	setupView(scr, theme, render, ev => {
		if (ev.kind === 'key') {
			if (ev.key.ctrl && ev.key.name === 'c') {
				requestQuit(); return;
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
		getFingerprints: () => { local: FingerprintSurface; peers: { username: string; fingerprint: FingerprintSurface; colorIdx: number }[] }
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
	sendBtn.bar = attachBtn.bar = rotateBtn.bar = true;

	// Sidebar two-mode pane. Hidden by default; toggled from the keys-display
	// (Esc, then E/V) or the /events and /verify commands.
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
		// Preserve the focused id across the rebuild; when it no longer exists
		// (e.g. chatInput after entering full-width) setById is a no-op and idx
		// falls back to 0 (the sidebar).
		const cur = ring.current();
		ring.clear();
		for (const id of chatFocusIds(layout().mode, picking)) ring.register(id);
		ring.setById(cur);
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

	// Modal keys-display: shown when the chat input is focused and Escape is
	// pressed. Only ever true while chatInput holds focus (reset when focus
	// leaves or the layout collapses to full-width).
	let keysMode = false;

	// FilePicker state
	let picking        = false;
	let pathInput: TextInput | null = null;
	let cancelBtn: Button | null    = null;
	let tabMatches:  string[] = [];
	let tabIdx         = -1;
	let tabCycled      = '';

	// last layout class rendered; crossing a class boundary (resize, toggle)
	// rebuilds the focus ring so it never points at a hidden widget.
	let lastLayoutSig = '';

	rebuildRing();

	function showHelp(): void {
		const text = [
			'available commands:',
			'  /exit (/quit, /q, /part)  quit covcom',
			'  /ratchet                  rotate keys',
			'  /events                   toggle event log',
			'  /verify                   toggle verify pane',
			'  /help (/?)                show this list',
		].join('\n');
		appendMessage({ sender: 'system', text, isSelf: false, system: true });
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
			text: `unknown command: ${raw}. type /help for a list`,
			isSelf: false,
			system: true,
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
		cancelBtn.bar = true;
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

	// Thin wrappers feeding live screen/sidebar state into the pure layout
	// decision (chatLayout/chatFocusIds at module scope).
	function layout(): ChatLayout {
		return chatLayout(sidebar.isOpen(), scr.w, sidebar.width);
	}
	function sidebarFullWidth(): boolean {
		return layout().mode === 'full';
	}

	// Flip the sidebar panel without touching focus. Wrapped by toggleMode, which
	// adds the focus move (sidebar on open, input on close).
	function setSidebarMode(target: SidebarMode) {
		if (target === null) return;
		if (sidebar.mode === target) sidebar.setMode(null);
		else                         sidebar.setMode(target);
		rebuildRing();
		scr.markDirty();
	}

	function toggleMode(target: SidebarMode) {
		if (target === null) return;
		const prev = sidebar.mode;
		setSidebarMode(target);
		// When opening from closed, jump focus to the sidebar so keyboard nav works.
		if (prev === null && sidebar.mode !== null) ring.setById('sidebar');
		// When closing, drop focus back onto chatInput.
		if (sidebar.mode === null) ring.setById('chatInput');
		afterFocusChange();
	}

	function render() {
		scr.hideCursor();
		const lo = layout();

		// Rebuild the focus ring when the layout class changes (resize across the
		// 80-col threshold, or a sidebar toggle). Idempotent with the explicit
		// rebuildRing() calls elsewhere, which leave the sig unchanged.
		const sig = `${picking}|${lo.mode}`;
		if (sig !== lastLayoutSig) {
			lastLayoutSig = sig; rebuildRing();
		}

		// Terminal too narrow for a split: the sidebar takes the whole screen and
		// the chat is hidden until it is closed (Tab/Esc). The input (and so the
		// keys-display) is gone, so drop the modal.
		if (lo.mode === 'full') {
			keysMode = false;
			sidebar.render(scr, { x: 1, y: 1, w: scr.w, h: scr.h }, true, theme);
			return;
		}

		const sideW   = lo.sideW;
		const sideOn  = lo.mode === 'side';
		const chatW   = lo.chatW;
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
			scr.write(colorBg(theme.barBg) + colorFg(theme.barAttach) + ansi.bold + lblAttach + ansi.reset);

			pathInput.render(scr, { x: inputX,    y: barY, w: inputW, h: 1 }, ring.isFocused('pathInput'), theme);
			cancelBtn.render(scr, { x: chatW - 3, y: barY, w: 3,      h: 1 }, ring.isFocused('cancelBtn'), theme);
		} else if (keysMode) {
			renderKeysBar(scr, 2, barY, theme, keyHints(cfg));
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
		} else if (!picking && !keysMode && fid === 'chatInput') {
			const p = chatInput.getCursorPos(); scr.showCursor(p.x, p.y);
		}
	}

	_chatRender = render;

	setupView(scr, theme, render, ev => {
		if (ev.kind === 'key') {
			const key = ev.key;
			if (key.ctrl && key.name === 'c') {
				requestQuit(); return;
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
					if (!existsSync(p) || !statSync(p).isFile()) {
						showModal({
							title: 'File Not Found',
							body: `No file exists at:\n${p}`,
							accent: theme.error,
						});
						return;
					}
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

			// modal keys-display: while shown, only the action keys and Escape are
			// live; every other key is swallowed (shift-insensitive). Ctrl+C still
			// quits (handled above). Every action closes the modal: ratchet returns
			// focus to the input, e/v defer to toggleMode's focus move (sidebar on
			// open, input on close), and Escape just returns to the input.
			if (keysMode) {
				const n = key.name.toLowerCase();
				if (n === 'r')      {
					keysMode = false; opts.onRotate(); ring.setById('chatInput'); scr.markDirty(); return;
				}
				if (n === 'e')      {
					keysMode = false; toggleMode('event-log'); return;
				}
				if (n === 'v')      {
					keysMode = false; toggleMode('verify'); return;
				}
				if (n === 'escape') {
					keysMode = false; scr.markDirty(); return;
				}
				return;
			}

			// normal chat mode. Escape from the chat input opens the modal
			// keys-display (ratchet / events / verify also have slash commands).
			if (key.name === 'escape' && ring.isFocused('chatInput')) {
				keysMode = true; scr.markDirty(); return;
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
			// Full-width sidebar: chat is hidden, so Tab has nothing else to
			// cycle. Treat it as the close-and-return exit (same path as Esc).
			if (key.name === 'tab' && sidebarFullWidth()) {
				sidebar.setMode(null);
				rebuildRing();
				ring.setById('chatInput');
				afterFocusChange();
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
			// Full-width sidebar: chat widgets are not drawn but keep stale rects,
			// so route every event to the sidebar and ignore clicks (no widget to
			// focus). The sidebar fills the screen, so any scroll is over it.
			if (sidebarFullWidth()) {
				if (m.type === 'scroll') {
					sidebar.scrollByLines(m.button === 64 ? -3 : +3);
					scr.markDirty();
				}
				return;
			}
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
					keysMode = false;
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
			} else if (!picking && !keysMode && ring.isFocused('chatInput')) {
				chatInput.onPaste(ev.text); scr.markDirty();
			}
		}
	});
}

// ─── appendMessage / appendFile ───────────────────────────────────────────────

export function appendMessage(msg: {
	sender:       string
	text:         string
	isSelf:       boolean
	senderIndex?: number
	system?:      boolean
	ratchet?:     boolean
	ratchetIcon?: string
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
