import { join, resolve } from 'path';
import { readdirSync } from 'fs';
import { parseArmoredInvite, inviteFilename } from '@covcom/lib';
import type { InvitePayload, FingerprintSurface } from '@covcom/lib';
import { Screen, loadTheme, colorFg, colorBg, ansi } from './screen.js';
import { parseInput, InputEvent } from './keys.js';
import { FocusRing } from './focus.js';
import { TextInput, TextArea, Button, ScrollView, Widget } from './widgets.js';
import { readConfig } from '../config.js';
import { resolveUniqueFilename } from '../util.js';
import { BANNER } from './banner.js';

// ─── banner ──────────────────────────────────────────────────────────────────

const BANNER_LINES = BANNER.split('\n').filter(l => l.length > 0);
const BANNER_W     = 56;  // visible cell width of the banner
const BANNER_H     = BANNER_LINES.length;
const BANNER_TOP   = 2;   // row offset from top of screen

// render the verify row at the given y. Renders the local user's color row
// followed by the hex fallback and a hint. Truncates if the terminal is too
// narrow.
function renderVerifyRow(
	scr:  Screen,
	y:    number,
	bg:   import('./screen.js').ColorValue,
	data: { local: FingerprintSurface; peers: { username: string; fingerprint: FingerprintSurface }[] },
): void {
	scr.fillRect(1, y, scr.w, 1, bg);
	const { local } = data;
	let x = 2;
	for (const hex of local.swatches) {
		if (x + 2 > scr.w) return;
		scr.fillRect(x, y, 2, 1, { type: 'hex', value: hex });
		x += 2;
	}
	x += 1;
	if (x + local.hex.length > scr.w) return;
	scr.moveTo(x, y);
	scr.write(colorBg(bg) + colorFg({ type: 'ansi16', n: 15 }) + ' ' + local.hex + ansi.reset);
	x += local.hex.length + 1;
	const hint = '  ctrl-v hides';
	if (x + hint.length > scr.w) return;
	scr.moveTo(x, y);
	scr.write(colorBg(bg) + colorFg({ type: 'ansi16', n: 8 }) + hint + ansi.reset);
}

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

function chatDoRender() {
	if (!_chatScreen || !_chatRender) return;
	_chatScreen.beginRender();
	_chatScreen.clear();
	_chatRender();
	_chatScreen.endRender();
}

// ─── shared view setup ───────────────────────────────────────────────────────

function setupView(scr: Screen, render: () => void, onEv: (ev: InputEvent) => void) {
	viewGen++;
	const gen = viewGen;
	if (_resizeCleanup) {
		_resizeCleanup(); _resizeCleanup = null;
	}
	process.stdin.removeAllListeners('data');

	process.stdin.on('data', (buf: Buffer) => {
		onEv(parseInput(buf));
		if (viewGen === gen && scr.needsRender()) {
			scr.beginRender(); scr.clear(); render(); scr.endRender();
		}
	});

	const onResize = () => {
		scr.needsRender();
		scr.beginRender(); scr.clear(); render(); scr.endRender();
	};
	process.stdout.on('resize', onResize);
	_resizeCleanup = () => process.stdout.removeListener('resize', onResize);

	scr.beginRender(); scr.clear(); render(); scr.endRender();
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

	setupView(scr, render, ev => {
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
	_scrollView = null; _chatScreen = null; _chatRender = null; _errorDisplay = null;
	const config = readConfig();
	const theme  = loadTheme(config);

	type Callout = { type: 'copy_ok' } | { type: 'copy_fail' } | { type: 'download'; path: string }
	let callout: Callout | null = null;

	const copyBtn     = new Button('copy',     'Copy Code', () => {
		void tryCopy(opts.armoredInvite, config.copyCmd).then(ok => {
			callout = ok ? { type: 'copy_ok' } : { type: 'copy_fail' };
			scr.beginRender(); scr.clear(); render(); scr.endRender();
		});
	});
	const downloadBtn = new Button('download', 'Download', () => {
		const outPath = resolveUniqueFilename(join(process.cwd(), inviteFilename(opts.roomId)));
		void Bun.write(outPath, opts.armoredInvite).then(() => {
			callout = { type: 'download', path: resolve(outPath) };
			scr.beginRender(); scr.clear(); render(); scr.endRender();
		});
	});

	const ring    = new FocusRing();
	ring.register('copy'); ring.register('download');
	const widgets: Widget[] = [copyBtn, downloadBtn];

	function calloutLines(cw: number): string[] {
		if (!callout) return [];
		if (callout.type === 'copy_ok')   return ['Code copied to your clipboard'.padEnd(cw)];
		if (callout.type === 'copy_fail') return ['Failed to find a clipboard manager'.padEnd(cw)];
		// download: wrap path
		const lines = ['file downloaded to:'.padEnd(cw)];
		let p = callout.path;
		while (p.length > cw) {
			lines.push(p.slice(0, cw)); p = p.slice(cw);
		}
		lines.push(p.padEnd(cw));
		return lines;
	}

	const TABLE = [
		'┌────────┬───────────────────────┐',
		'│ cipher │  XChaCha20-Poly1305   │',
		'│ kem    │  ML-KEM-768           │',
		'│ format │  0x01                 │',
		'└────────┴───────────────────────┘',
	];

	function render() {
		scr.hideCursor();
		const cw     = Math.min(scr.w - 8, 52);
		const ox     = Math.floor((scr.w - cw) / 2);
		const oy     = Math.max(1, Math.floor((scr.h - 11) / 2));

		scr.fillRect(1, 1, scr.w, scr.h, theme.bg);

		scr.moveTo(ox, oy);
		scr.write(colorFg(theme.fg) + ansi.bold + 'Room Code Generated Successfully' + ansi.reset);
		scr.moveTo(ox, oy + 1);
		scr.write(colorFg(theme.disabled) + 'Waiting for peer(s) to connect...' + ansi.reset);

		copyBtn.render(scr,     { x: ox,      y: oy + 3, w: 14, h: 1 }, ring.isFocused('copy'),     theme);
		downloadBtn.render(scr, { x: ox + 16, y: oy + 3, w: 14, h: 1 }, ring.isFocused('download'), theme);

		const cls  = calloutLines(cw);
		const tY   = callout ? oy + 5 + cls.length : oy + 5;

		// render callout
		for (let i = 0; i < cls.length; i++) {
			scr.fillRect(ox, oy + 5 + i, cw, 1, theme.calloutBg);
			scr.moveTo(ox, oy + 5 + i);
			scr.write(colorBg(theme.calloutBg) + colorFg(theme.calloutFg) + cls[i] + ansi.reset);
		}

		// table
		for (let i = 0; i < TABLE.length; i++) {
			scr.moveTo(ox, tY + i);
			scr.write(colorFg(theme.fg) + TABLE[i] + ansi.reset);
		}
	}

	setupView(scr, render, ev => {
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

	setupView(scr, render, ev => {
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
	const theme = loadTheme(readConfig());

	const scrollView = new ScrollView('msgArea');
	_scrollView = scrollView;

	const chatInput = new TextInput('chatInput', '');
	const sendBtn   = new Button('sendBtn',   '>',  () => doSend());
	const rotateBtn = new Button('rotateBtn', 'R',  () => opts.onRotate());
	const attachBtn = new Button('attachBtn', '+',  () => enterPicking());

	const ring = new FocusRing();
	ring.register('chatInput'); ring.register('sendBtn');
	ring.register('rotateBtn'); ring.register('attachBtn'); ring.register('msgArea');
	const baseWidgets: Widget[] = [chatInput, sendBtn, rotateBtn, attachBtn, scrollView];

	// FilePicker state
	let picking        = false;
	let pathInput: TextInput | null = null;
	let cancelBtn: Button | null    = null;
	let tabMatches:  string[] = [];
	let tabIdx         = -1;
	let tabCycled      = '';

	function doSend() {
		const text = chatInput.value.trim();
		if (!text) return;
		chatInput.setValue('');
		opts.onSend(text);
	}

	function enterPicking() {
		picking    = true;
		pathInput  = new TextInput('pathInput', '');
		cancelBtn  = new Button('cancelBtn', 'x', () => exitPicking());
		tabMatches = []; tabIdx = -1; tabCycled = '';

		ring.clear();
		ring.register('pathInput'); ring.register('cancelBtn');
		scr.markDirty();
	}

	function exitPicking() {
		picking   = false;
		pathInput = null; cancelBtn = null;

		ring.clear();
		ring.register('chatInput'); ring.register('sendBtn');
		ring.register('rotateBtn'); ring.register('attachBtn'); ring.register('msgArea');
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

	let verifyVisible = false;

	function render() {
		scr.hideCursor();
		const verifyH = verifyVisible ? 1 : 0;
		const msgH    = scr.h - 3 - verifyH;
		const verifyY = scr.h - 3;
		const sepY    = scr.h - 2;
		const barY    = scr.h - 1;

		scrollView.render(scr, { x: 1, y: 1, w: scr.w, h: msgH }, ring.isFocused('msgArea'), theme);

		if (verifyVisible) {
			renderVerifyRow(scr, verifyY, theme.barBg, opts.getFingerprints());
		}

		// separator
		scr.fillRect(1, sepY, scr.w, 1, theme.barBg);
		// bar background
		scr.fillRect(1, barY, scr.w, 1, theme.barBg);

		if (picking && pathInput && cancelBtn) {
			pathInput.render(scr, { x: 2, y: barY, w: scr.w - 6, h: 1 }, ring.isFocused('pathInput'), theme);
			cancelBtn.render(scr, { x: scr.w - 3, y: barY, w: 3, h: 1 }, ring.isFocused('cancelBtn'), theme);
		} else {
			chatInput.render(scr, { x: 2,          y: barY, w: scr.w - 16, h: 1 }, ring.isFocused('chatInput'), theme);
			sendBtn.render(scr,   { x: scr.w - 13, y: barY, w: 5,          h: 1 }, ring.isFocused('sendBtn'),   theme);
			rotateBtn.render(scr, { x: scr.w - 7,  y: barY, w: 4,          h: 1 }, ring.isFocused('rotateBtn'), theme);
			attachBtn.render(scr, { x: scr.w - 3,  y: barY, w: 3,          h: 1 }, ring.isFocused('attachBtn'), theme);
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

	setupView(scr, render, ev => {
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
					const p = resolve(pathInput.value.trim());
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
			if (key.ctrl && key.name === 'v') {
				verifyVisible = !verifyVisible;
				scr.markDirty(); return;
			}
			if (key.name === 'tab' && !key.shift) {
				ring.next(); scr.markDirty(); return;
			}
			if (key.name === 'tab' && key.shift)  {
				ring.prev(); scr.markDirty(); return;
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
}): void {
	if (!_scrollView || !_chatScreen) return;
	_scrollView.addFile(msg);
	_chatScreen.markDirty();
	chatDoRender();
}
