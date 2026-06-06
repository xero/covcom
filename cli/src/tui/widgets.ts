import { parseMarkup, stripFormatChars } from '@covcom/lib';
import type { FingerprintSurface, Span } from '@covcom/lib';
import { formatBytes } from '../util.js';
import { Screen, Theme, ColorValue, colorFg, colorBg, ansi } from './screen.js';
import type { Key } from './keys.js';
import { getEvents, subscribeEvents, type EventLogEntry } from '../eventLog.js';
import { SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_STEP } from '../config.js';

export interface Rect { x: number; y: number; w: number; h: number }

export interface Widget {
	id:       string
	rect:     Rect
	render(scr: Screen, rect: Rect, focused: boolean, theme: Theme): void
	onKey(key: Key): boolean
	onPaste?(text: string): void
	onClick?(): void
}

// ─── word wrap ───────────────────────────────────────────────────────────────
//
// Widths are measured in display columns (see displayWidth), so a CJK/emoji run
// wraps where it actually fills the pane rather than one column short. A word
// wider than the pane is hard-split via charWrap, which is column-aware and never
// severs a surrogate pair.

export function wordWrap(text: string, width: number): string[] {
	if (width <= 0) return [text];
	const words  = text.split(' ');
	const lines: string[] = [];
	let cur = '';
	for (const word of words) {
		if (displayWidth(word) > width) {
			if (cur) lines.push(cur);
			const segs = charWrap(word, width);
			for (let i = 0; i < segs.length - 1; i++) lines.push(segs[i]);
			cur = segs[segs.length - 1];
			continue;
		}
		const needed = cur ? displayWidth(cur) + 1 + displayWidth(word) : displayWidth(word);
		if (needed > width) {
			lines.push(cur); cur = word;
		} else cur = cur ? cur + ' ' + word : word;
	}
	if (cur) lines.push(cur);
	return lines.length ? lines : [''];
}

// ─── display width ─────────────────────────────────────────────────────────────
//
// A terminal cell is not a code point. East Asian Wide/Fullwidth glyphs and most
// emoji occupy two columns; combining marks and the zero-width format chars we
// deliberately keep (ZWJ, variation selectors) occupy none. Wrapping and padding
// must count columns, not code points, or a CJK glyph or width-2 emoji in a
// fenced block pads/wraps one column short. This is a pragmatic wcwidth: the
// canonical wide ranges below are width 2, marks/kept-format chars are width 0,
// everything else is width 1.
//
// Caveat: width is summed per code point, so a multi-code-point grapheme cluster
// joined by ZWJ (e.g. a family emoji) over-counts its parts. Terminals disagree
// on those anyway, and ASCII/CJK/single-emoji is the stated target.

// Standard East Asian Wide + Fullwidth blocks plus the emoji/pictograph planes.
const WIDE_RANGES: readonly (readonly [number, number])[] = [
	[0x1100, 0x115f],    // Hangul Jamo
	[0x2329, 0x232a],    // angle brackets
	[0x2e80, 0x303e],    // CJK radicals … Kangxi
	[0x3041, 0x33ff],    // Hiragana … CJK compatibility
	[0x3400, 0x4dbf],    // CJK Extension A
	[0x4e00, 0x9fff],    // CJK Unified Ideographs
	[0xa000, 0xa4cf],    // Yi
	[0xac00, 0xd7a3],    // Hangul syllables
	[0xf900, 0xfaff],    // CJK compatibility ideographs
	[0xfe10, 0xfe19],    // vertical forms
	[0xfe30, 0xfe6f],    // CJK compatibility + small forms
	[0xff00, 0xff60],    // fullwidth forms
	[0xffe0, 0xffe6],    // fullwidth signs
	[0x1f300, 0x1faff],  // emoji & pictographs
	[0x20000, 0x3fffd],  // CJK Extension B+ (supplementary ideographic planes)
];

// Combining marks render zero-width over a base glyph. \p{M} covers them; no `g`
// flag, so lastIndex never advances between tests.
const COMBINING_RE = /\p{M}/u;

function charWidth(cp: number): number {
	// Zero-width: ZWJ and variation selectors (kept by stripFormatChars) and any
	// combining mark. The base glyph of an emoji/accented cluster carries the width.
	if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
	if (COMBINING_RE.test(String.fromCodePoint(cp))) return 0;
	for (const [lo, hi] of WIDE_RANGES) if (cp >= lo && cp <= hi) return 2;
	return 1;
}

// Visible width of a string in terminal columns.
function displayWidth(s: string): number {
	let w = 0;
	for (const ch of s) w += charWidth(ch.codePointAt(0) ?? 0);
	return w;
}

// ─── terminal sanitization ─────────────────────────────────────────────────────
//
// The CLI renders untrusted peer data (usernames, error reasons, message text)
// as raw bytes to process.stdout, so the real threat is ANSI/CSI/OSC escape
// injection (OSC 52 clipboard writes, screen clears, cursor moves), not HTML.
// Strip full escape sequences first (while the ESC anchor is present), then stray
// control chars, then HTML-ish tags for defensive parity, then the shared
// bidi/zero-width format chars (display-name reordering + homoglyph spoofing).
// Newlines (0x0A) are preserved so multi-line messages and fenced blocks survive
// into parseMarkup; the event-log path flattens them itself since it is single-line.

// Order matters: OSC (ESC ] … BEL/ST) and CSI (ESC [ …) are matched before the
// generic two-char escape, because that class's `\-_` range covers `]` (0x5D)
// and would otherwise shadow OSC, leaving the OSC body (e.g. an OSC 52 clipboard
// payload) on screen.
// eslint-disable-next-line no-control-regex -- matching ESC/BEL/ST escapes is the point
const ANSI_RE = /\x1B(?:\][^\x07\x1B]*(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;

export function sanitizeTerminal(s: string): string {
	const stripped = s
		.replace(ANSI_RE, '')                           // CSI, OSC (incl. OSC 52), 2-char escapes
		// eslint-disable-next-line no-control-regex -- stripping stray C0/C1 control bytes is the point
		.replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, ''); // stray C0/C1 + DEL, keep \n (0x0A)
	// Strip HTML-ish tags to a fixed point: a single pass can leave a tag re-formed
	// from overlapping `<…>` runs, so repeat until the string is stable.
	let tagless = stripped;
	let prev: string;
	do {
		prev = tagless;
		tagless = tagless.replace(/<[^>]*>/g, '');      // stray HTML-ish tags (defensive parity)
	} while (tagless !== prev);
	return stripFormatChars(tagless);                   // bidi controls + zero-width spoofing chars
}

// ─── markup → ANSI ──────────────────────────────────────────────────────────────
//
// Message flow on the CLI is sanitizeTerminal → parseMarkup → emit our own
// controlled SGR. The markup markers (* _ `) are ASCII and survive sanitization,
// and we only ever wrap our own bytes in an escape position, never attacker
// bytes. Wrapping is done on VISIBLE width first, then SGR is injected around the
// visible runs, so column math stays correct.

type Sty = 'plain' | 'b' | 'i' | 'bi' | 'code';
interface StyledChar { ch: string; sty: Sty }

function styledChars(spans: Span[]): StyledChar[] {
	const out: StyledChar[] = [];
	const push = (str: string, sty: Sty): void => {
		for (const ch of str) out.push({ ch, sty });
	};
	for (const s of spans) {
		if (typeof s === 'string') push(s, 'plain');
		else if ('b' in s)         push(s.b, 'b');
		else if ('i' in s)         push(s.i, 'i');
		else if ('bi' in s)        push(s.bi, 'bi');
		else                       push(s.code, 'code');
	}
	return out;
}

// Display-column width of a styled run; each StyledChar.ch is one code point.
function styledWidth(cs: StyledChar[]): number {
	let n = 0;
	for (const c of cs) n += charWidth(c.ch.codePointAt(0) ?? 0);
	return n;
}

// charWrap for styled runs: hard-split into column-bounded chunks, stepping over
// whole code points (each StyledChar is one) so a wide glyph is never severed.
function charWrapStyled(word: StyledChar[], width: number): StyledChar[][] {
	const out: StyledChar[][] = [];
	let cur: StyledChar[] = [];
	let curW = 0;
	for (const c of word) {
		const cw = charWidth(c.ch.codePointAt(0) ?? 0);
		if (cur.length && curW + cw > width) {
			out.push(cur); cur = []; curW = 0;
		}
		cur.push(c); curW += cw;
	}
	if (cur.length) out.push(cur);
	return out.length ? out : [[]];
}

// Word-wrap over styled chars, mirroring wordWrap's plain-text behavior so the
// feel is unchanged: break on spaces, hard-split words wider than the pane.
// Widths are display columns, not code-point counts, matching wordWrap.
function wrapStyled(chars: StyledChar[], width: number): StyledChar[][] {
	if (width <= 0) return [chars];
	const words: StyledChar[][] = [];
	let w: StyledChar[] = [];
	for (const c of chars) {
		if (c.ch === ' ') {
			words.push(w); w = [];
		} else w.push(c);
	}
	words.push(w);

	const SP: StyledChar = { ch: ' ', sty: 'plain' };
	const lines: StyledChar[][] = [];
	let cur: StyledChar[] = [];
	for (const word of words) {
		if (styledWidth(word) > width) {
			if (cur.length) lines.push(cur);
			const segs = charWrapStyled(word, width);
			for (let i = 0; i < segs.length - 1; i++) lines.push(segs[i]);
			cur = segs[segs.length - 1];
			continue;
		}
		const needed = cur.length ? styledWidth(cur) + 1 + styledWidth(word) : styledWidth(word);
		if (needed > width) {
			lines.push(cur); cur = word.slice();
		} else {
			cur = cur.length ? [...cur, SP, ...word] : word.slice();
		}
	}
	if (cur.length) lines.push(cur);
	return lines.length ? lines : [[]];
}

function styleOpen(sty: Sty, baseFg: string, theme: Theme): string {
	switch (sty) {
	case 'b':    return baseFg + ansi.bold;
	case 'i':    return baseFg + ansi.italic;
	case 'bi':   return baseFg + ansi.bold + ansi.italic;
	case 'code': return colorBg(theme.codeBg) + colorFg(theme.codeFg);
	default:     return baseFg;
	}
}

// Coalesce consecutive same-style chars into runs; each run is wrapped in its
// SGR opener and a reset, matching the "wrap each run, then ansi.reset" pattern.
function renderStyledLine(chars: StyledChar[], baseFg: string, theme: Theme): string {
	let out = '';
	let i = 0;
	while (i < chars.length) {
		const sty = chars[i].sty;
		let text = '';
		while (i < chars.length && chars[i].sty === sty) {
			text += chars[i].ch; i++;
		}
		out += styleOpen(sty, baseFg, theme) + text + ansi.reset;
	}
	return out;
}

// Hard character wrap for fenced blocks: never collapse spacing, never clip.
// Lines wider than the pane wrap at the column boundary onto continuation lines.
// Width is counted in display columns (a CJK glyph / wide emoji is 2), and the
// scan steps over whole code points, so an astral char at the boundary is never
// severed into a lone surrogate. A single code point wider than the pane still
// gets its own line rather than being dropped.
function charWrap(s: string, width: number): string[] {
	if (width <= 0) return [s];
	if (s.length === 0) return [''];
	const out: string[] = [];
	let cur  = '';
	let curW = 0;
	for (const ch of s) {
		const cw = charWidth(ch.codePointAt(0) ?? 0);
		if (cur !== '' && curW + cw > width) {
			out.push(cur); cur = ''; curW = 0;
		}
		cur += ch; curW += cw;
	}
	if (cur !== '') out.push(cur);
	return out.length ? out : [''];
}

// Render a message body to visible-width lines (without the sender prefix).
// `pre` blocks get a solid code bg/fg fill padded to the wrap width; `p` blocks
// word-wrap with per-run SGR. Returns at least one line.
export function messageToLines(text: string, width: number, baseFg: string, theme: Theme): string[] {
	const doc = parseMarkup(sanitizeTerminal(text));
	const out: string[] = [];
	for (const block of doc) {
		if ('pre' in block) {
			const codeSeq = colorBg(theme.codeBg) + colorFg(theme.codeFg);
			for (const raw of block.pre.split('\n')) {
				for (const seg of charWrap(raw, width)) {
					// Pad to the wrap width in display columns (charWrap yields ≤ width).
					const pad = ' '.repeat(Math.max(0, width - displayWidth(seg)));
					out.push(codeSeq + seg + pad + ansi.reset);
				}
			}
		} else {
			for (const lineChars of wrapStyled(styledChars(block.p), width)) {
				out.push(renderStyledLine(lineChars, baseFg, theme));
			}
		}
	}
	return out.length ? out : [''];
}

// ─── drawModal ───────────────────────────────────────────────────────────────

export interface ModalOpts {
	title:   string
	body:    string
	accent?: ColorValue
}

export function drawModal(scr: Screen, theme: Theme, opts: ModalOpts): void {
	const border  = opts.accent ?? theme.modalBorder;
	const titleFg = opts.accent ?? theme.modalTitle;

	const maxInner = Math.max(8, scr.w - 12);
	const targetInner = Math.min(maxInner, Math.max(24, opts.title.length));
	const rawLines: string[] = [];
	for (const seg of opts.body.split('\n')) {
		for (const line of wordWrap(seg, targetInner)) rawLines.push(line);
	}
	const longest = rawLines.reduce((m, l) => Math.max(m, l.length), 0);
	const innerW  = Math.min(maxInner, Math.max(opts.title.length, longest, 24));

	const boxW = innerW + 4;
	const boxH = rawLines.length + 5;
	const ox   = Math.max(1, Math.floor((scr.w - boxW) / 2));
	const oy   = Math.max(1, Math.floor((scr.h - boxH) / 2));

	scr.fillRect(ox, oy, boxW, boxH, border);
	scr.fillRect(ox + 1, oy + 1, boxW - 2, boxH - 2, theme.modalBg);

	const bg = colorBg(theme.modalBg);
	scr.moveTo(ox + 2, oy + 2);
	scr.write(bg + ansi.bold + colorFg(titleFg) + opts.title + ansi.reset);

	const fg = colorFg(theme.modalFg);
	for (let i = 0; i < rawLines.length; i++) {
		scr.moveTo(ox + 2, oy + 3 + i);
		scr.write(bg + fg + rawLines[i] + ansi.reset);
	}
}

// ─── TextInput ────────────────────────────────────────────────────────────────

export class TextInput implements Widget {
	id:            string;
	rect:          Rect = { x: 0, y: 0, w: 0, h: 0 };
	value:         string;
	cursor:        number;
	displayOffset: number;

	constructor(id: string, initial = '') {
		this.id            = id;
		this.value         = initial;
		this.cursor        = initial.length;
		this.displayOffset = 0;
	}

	setValue(v: string) {
		this.value         = v;
		this.cursor        = v.length;
		this.displayOffset = 0;
	}

	getCursorPos(): { x: number; y: number } {
		return { x: this.rect.x + (this.cursor - this.displayOffset), y: this.rect.y };
	}

	render(scr: Screen, rect: Rect, focused: boolean, theme: Theme) {
		this.rect = rect;

		// keep cursor visible
		if (this.cursor < this.displayOffset)
			this.displayOffset = this.cursor;
		if (this.cursor > this.displayOffset + rect.w - 1)
			this.displayOffset = this.cursor - rect.w + 1;

		const visible   = this.value.slice(this.displayOffset, this.displayOffset + rect.w);
		const bg        = colorBg(theme.inputBg);
		const fg        = colorFg(theme.inputFg);
		const cursorPos = this.cursor - this.displayOffset;

		scr.fillRect(rect.x, rect.y, rect.w, rect.h, theme.inputBg);
		scr.moveTo(rect.x, rect.y);

		if (!focused) {
			scr.write(bg + fg + visible + ansi.reset);
			return;
		}

		const before     = visible.slice(0, cursorPos);
		const cursorChar = visible[cursorPos] ?? ' ';
		const after      = visible.slice(cursorPos + 1);
		scr.write(bg + fg + before + '\x1b[7m' + cursorChar + '\x1b[27m' + fg + after + ansi.reset);
	}

	onKey(key: Key): boolean {
		if (key.name === 'enter') return false;  // propagate to view

		if (key.name === 'left') {
			if (this.cursor > 0) this.cursor--;
			return true;
		}
		if (key.name === 'right') {
			if (this.cursor < this.value.length) this.cursor++;
			return true;
		}
		if (key.name === 'home'  || (key.ctrl && key.name === 'a')) {
			this.cursor = 0; return true;
		}
		if (key.name === 'end'   || (key.ctrl && key.name === 'e')) {
			this.cursor = this.value.length; return true;
		}
		if (key.name === 'backspace') {
			if (this.cursor > 0) {
				this.value  = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
				this.cursor--;
			}
			return true;
		}
		if (key.name === 'delete') {
			if (this.cursor < this.value.length)
				this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
			return true;
		}
		if (key.ctrl && key.name === 'k') {
			this.value = this.value.slice(0, this.cursor);
			return true;
		}
		if (key.ctrl && key.name === 'u') {
			this.value  = this.value.slice(this.cursor);
			this.cursor = 0;
			return true;
		}
		if (key.ch && !key.ctrl && key.ch.length === 1 && key.ch.charCodeAt(0) >= 0x20) {
			this.value  = this.value.slice(0, this.cursor) + key.ch + this.value.slice(this.cursor);
			this.cursor++;
			return true;
		}
		return false;
	}

	onPaste(text: string) {
		const clean     = text.replace(/\r?\n/g, '');
		this.value      = this.value.slice(0, this.cursor) + clean + this.value.slice(this.cursor);
		this.cursor    += clean.length;
	}
}

// ─── TextArea ─────────────────────────────────────────────────────────────────

export class TextArea implements Widget {
	id:           string;
	rect:         Rect = { x: 0, y: 0, w: 0, h: 0 };
	value:        string;
	cursor:       number;
	scrollOffset: number;

	constructor(id: string, initial = '') {
		this.id           = id;
		this.value        = initial;
		this.cursor       = initial.length;
		this.scrollOffset = 0;
	}

	private get lines(): string[] {
		return this.value.split('\n');
	}

	private lineCol(): { line: number; col: number } {
		const ls  = this.lines;
		let pos   = 0;
		for (let i = 0; i < ls.length; i++) {
			const end = pos + ls[i].length;
			if (this.cursor <= end) return { line: i, col: this.cursor - pos };
			pos = end + 1;
		}
		return { line: ls.length - 1, col: ls[ls.length - 1]?.length ?? 0 };
	}

	getCursorPos(): { x: number; y: number } {
		const { line, col } = this.lineCol();
		return { x: this.rect.x + col, y: this.rect.y + (line - this.scrollOffset) };
	}

	render(scr: Screen, rect: Rect, _focused: boolean, theme: Theme) {
		this.rect = rect;
		const ls  = this.lines;
		const { line } = this.lineCol();

		if (line < this.scrollOffset)              this.scrollOffset = line;
		if (line >= this.scrollOffset + rect.h)    this.scrollOffset = line - rect.h + 1;

		scr.fillRect(rect.x, rect.y, rect.w, rect.h, theme.inputBg);
		const bg = colorBg(theme.inputBg);
		const fg = colorFg(theme.inputFg);

		for (let r = 0; r < rect.h; r++) {
			const li  = r + this.scrollOffset;
			if (li >= ls.length) break;
			const row = ls[li].slice(0, rect.w);
			scr.moveTo(rect.x, rect.y + r);
			scr.write(bg + fg + row + ansi.reset);
		}
	}

	onKey(key: Key): boolean {
		if (key.name === 'enter') {
			this.value  = this.value.slice(0, this.cursor) + '\n' + this.value.slice(this.cursor);
			this.cursor++;
			return true;
		}
		if (key.name === 'left') {
			if (this.cursor > 0) this.cursor--;
			return true;
		}
		if (key.name === 'right') {
			if (this.cursor < this.value.length) this.cursor++;
			return true;
		}
		if (key.name === 'up') {
			const { line, col } = this.lineCol();
			if (line > 0) {
				const ls    = this.lines;
				const newL  = line - 1;
				const newC  = Math.min(col, ls[newL].length);
				let pos = 0;
				for (let i = 0; i < newL; i++) pos += ls[i].length + 1;
				this.cursor = pos + newC;
			}
			return true;
		}
		if (key.name === 'down') {
			const { line, col } = this.lineCol();
			const ls = this.lines;
			if (line < ls.length - 1) {
				const newL  = line + 1;
				const newC  = Math.min(col, ls[newL].length);
				let pos = 0;
				for (let i = 0; i < newL; i++) pos += ls[i].length + 1;
				this.cursor = pos + newC;
			}
			return true;
		}
		if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
			const { line } = this.lineCol();
			const ls = this.lines;
			let pos = 0;
			for (let i = 0; i < line; i++) pos += ls[i].length + 1;
			this.cursor = pos;
			return true;
		}
		if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
			const { line } = this.lineCol();
			const ls = this.lines;
			let pos = 0;
			for (let i = 0; i <= line; i++) pos += ls[i].length + (i < line ? 1 : 0);
			this.cursor = pos;
			return true;
		}
		if (key.name === 'backspace') {
			if (this.cursor > 0) {
				this.value  = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
				this.cursor--;
			}
			return true;
		}
		if (key.name === 'delete') {
			if (this.cursor < this.value.length)
				this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
			return true;
		}
		if (key.ch && !key.ctrl && key.ch.length === 1 && key.ch.charCodeAt(0) >= 0x20) {
			this.value  = this.value.slice(0, this.cursor) + key.ch + this.value.slice(this.cursor);
			this.cursor++;
			return true;
		}
		return false;
	}

	onPaste(text: string) {
		this.value   = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
		this.cursor += text.length;
	}
}

// ─── Button ───────────────────────────────────────────────────────────────────

export class Button implements Widget {
	id:       string;
	rect:     Rect = { x: 0, y: 0, w: 0, h: 0 };
	label:    string;
	disabled: boolean;
	action:   () => void;

	constructor(id: string, label: string, action: () => void, disabled = false) {
		this.id       = id;
		this.label    = label;
		this.action   = action;
		this.disabled = disabled;
	}

	render(scr: Screen, rect: Rect, focused: boolean, theme: Theme) {
		this.rect = rect;
		const bg: ColorValue = this.disabled ? theme.btnDisabledBg : focused ? theme.btnFocusBg : theme.btnBg;
		const fg: ColorValue = this.disabled ? theme.btnDisabledFg : focused ? theme.btnFocusFg : theme.btnFg;

		scr.fillRect(rect.x, rect.y, rect.w, rect.h, bg);
		const label = ` ${this.label} `;
		const lx    = rect.x + Math.max(0, Math.floor((rect.w - label.length) / 2));
		const ly    = rect.y + Math.floor(rect.h / 2);
		scr.moveTo(lx, ly);
		scr.write(colorBg(bg) + colorFg(fg) + label + ansi.reset);
	}

	onClick()  {
		if (!this.disabled) this.action();
	}
	onKey(key: Key): boolean {
		if ((key.name === 'enter' || key.name === 'space') && !this.disabled) {
			this.action();
			return true;
		}
		return false;
	}
}

// ─── ScrollView ───────────────────────────────────────────────────────────────

type StoredMsg =
	| { isFile: false; sender: string; text: string; isSelf: boolean; senderIndex: number }
	| {
		isFile: true
		sender: string
		filename: string
		size: number
		mime: string
		isSelf: boolean
		senderIndex: number
		saved?: string
		download?: () => Promise<string>
	}

interface RenderedLine {
	screenY:     number
	attachment?: { filename: string; chipX1: number; chipX2: number; saved?: string; msgIdx: number }
}

export class ScrollView implements Widget {
	id:     string;
	rect:   Rect = { x: 0, y: 0, w: 0, h: 0 };

	private msgs:          StoredMsg[] = [];
	private scrollTop      = 0;
	private autoScroll     = true;
	private totalLines     = 0;
	private renderedLines: RenderedLine[] = [];
	private selectedMsgIdx: number | null = null;

	constructor(id: string) {
		this.id = id;
	}

	addMessage(msg: { sender: string; text: string; isSelf: boolean; senderIndex: number }) {
		// The sender is a peer-controlled username rendered raw into the terminal
		// (with SGR) by computeLines; sanitize it here so its visible length also
		// drives prefix/indent math correctly. Message body text is sanitized
		// separately in messageToLines.
		this.msgs.push({ isFile: false, ...msg, sender: sanitizeTerminal(msg.sender) });
	}

	addFile(msg: {
		sender: string
		filename: string
		size: number
		mime: string
		isSelf: boolean
		senderIndex: number
		saved?: string
		download?: () => Promise<string>
	}) {
		// Both the sender and the filename are peer-controlled and rendered raw
		// into the attachment line; sanitize so the chip width / hit-test math
		// (chipX2 = chipX1 + chip.length - 1) is computed on the visible string.
		this.msgs.push({ isFile: true, ...msg, sender: sanitizeTerminal(msg.sender), filename: sanitizeTerminal(msg.filename) });
	}

	markSaved(msgIdx: number, savedPath: string) {
		const m = this.msgs[msgIdx];
		if (m?.isFile) m.saved = savedPath;
	}

	private attachmentMsgIndices(): number[] {
		const out: number[] = [];
		for (let i = 0; i < this.msgs.length; i++) {
			const m = this.msgs[i];
			if (m.isFile && m.download) out.push(i);
		}
		return out;
	}

	hasAttachments(): boolean {
		for (const m of this.msgs) if (m.isFile && m.download) return true;
		return false;
	}

	selectLatest() {
		const idxs = this.attachmentMsgIndices();
		this.selectedMsgIdx = idxs.length ? idxs[idxs.length - 1] : null;
	}

	getSelectedIdx(): number | null {
		return this.selectedMsgIdx;
	}

	triggerSelectedDownload(): void {
		if (this.selectedMsgIdx === null) return;
		const idx = this.selectedMsgIdx;
		const m = this.msgs[idx];
		if (!m?.isFile || !m.download) return;
		m.download()
			.then(saved => this.markSaved(idx, saved))
			.catch(() => { /* state.ts surfaces the error to the user */ });
	}

	private computeLines(lineW: number, theme: Theme, highlightMsgIdx: number | null) {
		interface ComputedLine { text: string; attachment?: RenderedLine['attachment'] }
		const result: ComputedLine[] = [];

		for (let mi = 0; mi < this.msgs.length; mi++) {
			const msg       = this.msgs[mi];
			const isSystem  = msg.senderIndex === 7;
			const nameFg    = msg.isSelf  ? colorFg(theme.yourName)
			                : isSystem    ? colorFg(theme.disabled)
			                :               colorFg(theme.peerName);
			const textFg    = msg.isSelf  ? colorFg(theme.yourMsg)
			                : isSystem    ? colorFg(theme.disabled)
			                :               colorFg(theme.peerMsg);
			const prefix    = `${msg.sender}: `;
			const prefixLen = prefix.length;

			if (!msg.isFile) {
				const contentW = Math.max(lineW - prefixLen, 10);
				const lines    = messageToLines(msg.text, contentW, textFg, theme);
				for (let li = 0; li < lines.length; li++) {
					if (li === 0) {
						result.push({ text: nameFg + msg.sender + ansi.reset + ': ' + lines[0] });
					} else {
						result.push({ text: ' '.repeat(prefixLen) + lines[li] });
					}
				}
			} else {
				const chip       = ` ${msg.filename} `;
				const chipX1     = prefixLen;        // relative to line start
				const chipX2     = chipX1 + chip.length - 1;
				const size       = formatBytes(msg.size);
				const selected   = mi === highlightMsgIdx;
				const chipBg     = selected ? theme.attachSelectedBg : theme.attachBg;
				const chipFg     = selected ? theme.attachSelectedFg : theme.attachFg;
				const line       = nameFg + msg.sender + ansi.reset + ':'
				                 + colorBg(chipBg) + colorFg(chipFg) + chip + ansi.reset
				                 + colorFg(theme.disabled) + ` (${size})` + ansi.reset;
				result.push({
					text: line,
					attachment: { filename: msg.filename, chipX1, chipX2, saved: msg.saved, msgIdx: mi },
				});
			}
		}
		return result;
	}

	render(scr: Screen, rect: Rect, focused: boolean, theme: Theme) {
		this.rect         = rect;
		this.renderedLines = [];

		const lineW   = rect.w - 1;  // reserve right col for scroll indicator
		const highlight = focused ? this.selectedMsgIdx : null;
		const allLines = this.computeLines(lineW, theme, highlight);
		this.totalLines   = allLines.length;

		if (this.autoScroll)
			this.scrollTop = Math.max(0, this.totalLines - rect.h);
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, this.totalLines - rect.h)));

		// Keep the selected attachment visible while focus is in the list.
		if (focused && this.selectedMsgIdx !== null) {
			let selLine = -1;
			for (let i = 0; i < allLines.length; i++) {
				if (allLines[i].attachment?.msgIdx === this.selectedMsgIdx) {
					selLine = i; break;
				}
			}
			if (selLine >= 0) {
				if (selLine < this.scrollTop) {
					this.scrollTop  = selLine;
					this.autoScroll = false;
				} else if (selLine >= this.scrollTop + rect.h) {
					this.scrollTop  = selLine - rect.h + 1;
					this.autoScroll = (this.scrollTop >= Math.max(0, this.totalLines - rect.h));
				}
			}
		}

		scr.fillRect(rect.x, rect.y, rect.w, rect.h, theme.bg);

		const visEnd = Math.min(this.scrollTop + rect.h, this.totalLines);
		for (let i = this.scrollTop; i < visEnd; i++) {
			const screenY = rect.y + (i - this.scrollTop);
			const line = allLines[i];
			if (!line) continue;
			scr.moveTo(rect.x, screenY);
			scr.write(line.text);

			const att = line.attachment;
			this.renderedLines.push({
				screenY,
				attachment: att
					? { ...att, chipX1: rect.x + att.chipX1, chipX2: rect.x + att.chipX2 }
					: undefined,
			});
		}

		// scroll indicator
		if (this.totalLines > rect.h) {
			const maxTop   = this.totalLines - rect.h;
			const pos      = maxTop > 0 ? Math.floor(this.scrollTop / maxTop * (rect.h - 1)) : 0;
			scr.moveTo(rect.x + rect.w - 1, rect.y + pos);
			scr.write(colorFg({ type: 'ansi16', n: 8 }) + '█' + ansi.reset);
		}
	}

	hitTest(x: number, y: number): { attachment: RenderedLine['attachment'] } | null {
		for (const rl of this.renderedLines) {
			if (rl.screenY === y && rl.attachment && x >= rl.attachment.chipX1 && x <= rl.attachment.chipX2)
				return { attachment: rl.attachment };
		}
		return null;
	}

	scrollUp(n: number) {
		this.scrollTop  = Math.max(0, this.scrollTop - n);
		this.autoScroll = false;
	}

	scrollDown(n: number) {
		const max       = Math.max(0, this.totalLines - (this.rect.h || 1));
		this.scrollTop  = Math.min(this.scrollTop + n, max);
		if (this.scrollTop >= max) this.autoScroll = true;
	}

	enableAutoScroll() {
		this.autoScroll = true;
	}

	private moveSelection(dir: -1 | 1) {
		const idxs = this.attachmentMsgIndices();
		if (!idxs.length) return;
		if (this.selectedMsgIdx === null) {
			this.selectedMsgIdx = dir === -1 ? idxs[idxs.length - 1] : idxs[0];
			return;
		}
		const cur = idxs.indexOf(this.selectedMsgIdx);
		if (cur === -1) {
			this.selectedMsgIdx = idxs[idxs.length - 1];
			return;
		}
		const next = Math.max(0, Math.min(idxs.length - 1, cur + dir));
		this.selectedMsgIdx = idxs[next];
	}

	onKey(key: Key): boolean {
		const hasAttach = this.hasAttachments();

		if (hasAttach && key.name === 'enter') {
			this.triggerSelectedDownload();
			return true;
		}
		if (hasAttach && key.name === 'up') {
			this.moveSelection(-1); return true;
		}
		if (hasAttach && key.name === 'down') {
			this.moveSelection(+1); return true;
		}

		if (key.name === 'up')       {
			this.scrollUp(1);  return true;
		}
		if (key.name === 'down')     {
			this.scrollDown(1); return true;
		}
		if (key.name === 'pageup')   {
			this.scrollUp(10); return true;
		}
		if (key.name === 'pagedown') {
			this.scrollDown(10); return true;
		}
		return false;
	}
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
//
// Two-mode side pane: event-log mirrors the web sidebar's event feed; verify
// renders the local + peer fingerprints (8 truecolor swatches + 16-char hex).
// `mode` of null means hidden; the chat view should not allocate a column.

export type SidebarMode = 'event-log' | 'verify' | null;

type GetFingerprints = () => {
	local: FingerprintSurface
	peers: { username: string; fingerprint: FingerprintSurface }[]
}

interface RenderedLogRow {
	screenY: number
	entryId: number
	isHeader: boolean
}

const KIND_LABEL_W = 9;
const TIME_W       = 8;

const KIND_ERROR   = new Set(['error', 'fatal', 'message-fail', 'claim-reject', 'decrypt-fail', 'send-fail']);
const KIND_MEMBER  = new Set(['join', 'rejoin', 'part', 'peer_joined', 'peer_left']);
const KIND_RATCHET = new Set(['ratchet', 'ratchet-step', 'ratchet-step-fwd', 'ratchet_step', 'ratchet_step_fwd']);

function kindColor(kind: string, theme: Theme): ColorValue {
	if (KIND_ERROR.has(kind))   return theme.evtKindError;
	if (KIND_MEMBER.has(kind))  return theme.evtKindMember;
	if (KIND_RATCHET.has(kind)) return theme.evtKindRatchet;
	return theme.evtKindDefault;
}

function fmtTime(ts: number): string {
	const d  = new Date(ts);
	const hh = String(d.getHours()).padStart(2, '0');
	const mm = String(d.getMinutes()).padStart(2, '0');
	const ss = String(d.getSeconds()).padStart(2, '0');
	return `${hh}:${mm}:${ss}`;
}

// Event-log values are single-line; collapse any surviving newlines after the
// shared terminal sanitizer has stripped escapes and control bytes.
function flatten(s: string): string {
	return sanitizeTerminal(s).replace(/[\n\r]+/g, ' ');
}

function dirGlyph(d: EventLogEntry['direction']): string {
	if (d === 'in')  return '←';
	if (d === 'out') return '→';
	return '·';
}

function truncate(s: string, w: number): string {
	if (w <= 0) return '';
	if (s.length <= w) return s;
	if (w <= 1) return s.slice(0, w);
	return s.slice(0, w - 1) + '…';
}

export class Sidebar implements Widget {
	id   = 'sidebar';
	rect: Rect = { x: 0, y: 0, w: 0, h: 0 };

	mode:  SidebarMode = null;
	width: number;

	private scrollTop      = 0;
	private autoScroll     = true;
	private selectedId:    number | null = null;
	private expanded       = new Set<number>();
	private rendered:      RenderedLogRow[] = [];
	private totalLines     = 0;
	private getFingerprints: GetFingerprints;
	private username:        string;

	private _unsubscribe:    (() => void) | null = null;
	private _onChange:       (() => void) | null = null;

	constructor(width: number, getFingerprints: GetFingerprints, username: string) {
		this.width           = width;
		this.getFingerprints = getFingerprints;
		this.username        = username;
	}

	setMode(m: SidebarMode): void {
		this.mode = m;
		if (m === 'event-log') {
			// Snap back to live tail when the user re-opens the log.
			this.autoScroll = true;
		}
	}

	isOpen(): boolean {
		return this.mode !== null;
	}

	setWidth(w: number): number {
		this.width = Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.round(w)));
		return this.width;
	}

	// Subscribe to event-log pushes. `onChange` should mark the screen dirty
	// and re-render. Returned dispose tears down the subscription.
	attach(onChange: () => void): () => void {
		this._onChange    = onChange;
		this._unsubscribe = subscribeEvents(() => {
			if (this._onChange) this._onChange();
		});
		return () => this.dispose();
	}

	dispose(): void {
		if (this._unsubscribe) {
			this._unsubscribe(); this._unsubscribe = null;
		}
		this._onChange = null;
	}

	render(scr: Screen, rect: Rect, focused: boolean, theme: Theme): void {
		this.rect = rect;
		if (rect.w <= 0 || rect.h <= 0) return;

		scr.fillRect(rect.x, rect.y, rect.w, rect.h, theme.bg);
		this._renderTabs(scr, rect, theme);

		const bodyY = rect.y + 1;
		const bodyH = rect.h - 1;
		if (bodyH <= 0) return;

		const bodyRect = { x: rect.x, y: bodyY, w: rect.w, h: bodyH };
		if (this.mode === 'event-log') this._renderEventLog(scr, bodyRect, focused, theme);
		else if (this.mode === 'verify') this._renderVerify(scr, bodyRect, theme);
	}

	private _renderTabs(scr: Screen, rect: Rect, theme: Theme): void {
		scr.fillRect(rect.x, rect.y, rect.w, 1, theme.barBg);
		const tabs: { label: string; active: boolean }[] = [
			{ label: ' events ', active: this.mode === 'event-log' },
			{ label: ' verify ', active: this.mode === 'verify'    },
		];
		let x = rect.x;
		for (const t of tabs) {
			if (x >= rect.x + rect.w) break;
			const w = Math.min(t.label.length, rect.x + rect.w - x);
			const bg: ColorValue = t.active ? theme.btnFocusBg : theme.btnBg;
			const fg: ColorValue = t.active ? theme.btnFocusFg : theme.btnFg;
			scr.fillRect(x, rect.y, w, 1, bg);
			scr.moveTo(x, rect.y);
			scr.write(colorBg(bg) + colorFg(fg) + t.label.slice(0, w) + ansi.reset);
			x += w + 1;
		}
	}

	private _computeEventLines(rect: Rect, theme: Theme): { text: string; entryId: number; isHeader: boolean }[] {
		const events = getEvents();
		const lines: { text: string; entryId: number; isHeader: boolean }[] = [];
		const w      = rect.w;
		const msgFg  = colorFg(theme.evtMsg);
		const keyFg  = colorFg(theme.evtKey);
		const valFg  = colorFg(theme.evtVal);

		for (const e of events) {
			const time   = fmtTime(e.ts);
			const dir    = dirGlyph(e.direction);
			const kind   = truncate(e.kind, KIND_LABEL_W);
			const sumRoom = Math.max(0, w - (TIME_W + 1 + 1 + 1 + KIND_LABEL_W + 1));
			const sum    = truncate(flatten(e.summary), sumRoom);

			const m = /^([^\s:]+):\s+(.*)$/.exec(sum);
			let sumSeg: string;
			if (m) {
				const userFg = m[1] === this.username ? colorFg(theme.evtSelf) : colorFg(theme.evtPeer);
				sumSeg = userFg + m[1] + ansi.reset + msgFg + ': ' + m[2] + ansi.reset;
			} else {
				sumSeg = msgFg + sum + ansi.reset;
			}

			const text   = colorFg(theme.evtTime) + time + ansi.reset + ' '
			             + colorFg(theme.evtArrow) + dir + ansi.reset + ' '
			             + colorFg(kindColor(e.kind, theme)) + kind.padEnd(KIND_LABEL_W) + ansi.reset + ' '
			             + sumSeg;
			lines.push({ text, entryId: e.id, isHeader: true });

			if (this.expanded.has(e.id)) {
				for (const [k, v] of Object.entries(e.details)) {
					// Key and value are both peer-influenced (e.g. broadcast meta.*
					// keys), so both must pass through the terminal sanitizer.
					const key   = flatten(k);
					const val   = flatten(typeof v === 'string' ? v : JSON.stringify(v));
					const head  = `  ${key}: `;
					const room  = Math.max(0, w - head.length);
					const vTrim = truncate(val, room);
					const line  = keyFg + `  ${key}:` + ansi.reset + ' ' + valFg + vTrim + ansi.reset;
					lines.push({ text: line, entryId: e.id, isHeader: false });
				}
			}
		}
		return lines;
	}

	private _renderEventLog(scr: Screen, rect: Rect, focused: boolean, theme: Theme): void {
		const lines = this._computeEventLines(rect, theme);
		this.totalLines = lines.length;

		if (this.autoScroll) this.scrollTop = Math.max(0, this.totalLines - rect.h);
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, this.totalLines - rect.h)));

		this.rendered = [];
		const visEnd  = Math.min(this.scrollTop + rect.h, this.totalLines);
		for (let i = this.scrollTop; i < visEnd; i++) {
			const li      = lines[i];
			const screenY = rect.y + (i - this.scrollTop);
			const selected = focused && li.entryId === this.selectedId && li.isHeader;
			if (selected) {
				scr.fillRect(rect.x, screenY, rect.w, 1, theme.btnFocusBg);
				scr.moveTo(rect.x, screenY);
				// Render line text on the selected bg; foreground sequences inside li.text
				// will override per-segment, but we paint a base inverted bg first.
				scr.write(colorBg(theme.btnFocusBg) + li.text);
			} else {
				scr.moveTo(rect.x, screenY);
				scr.write(li.text);
			}
			this.rendered.push({ screenY, entryId: li.entryId, isHeader: li.isHeader });
		}

		if (this.totalLines > rect.h) {
			const maxTop = this.totalLines - rect.h;
			const pos    = maxTop > 0 ? Math.floor(this.scrollTop / maxTop * (rect.h - 1)) : 0;
			scr.moveTo(rect.x + rect.w - 1, rect.y + pos);
			scr.write(colorFg(theme.disabled) + '█' + ansi.reset);
		}

		if (focused && this.selectedId === null) {
			// On first focus, snap selection to the last visible header.
			for (let i = this.rendered.length - 1; i >= 0; i--) {
				if (this.rendered[i].isHeader) {
					this.selectedId = this.rendered[i].entryId;
					break;
				}
			}
		}
	}

	private _renderVerify(scr: Screen, rect: Rect, theme: Theme): void {
		const fps = this.getFingerprints();
		let y     = rect.y;
		const writeLine = (text: string) => {
			if (y >= rect.y + rect.h) return;
			scr.moveTo(rect.x, y);
			scr.write(text);
			y++;
		};
		const writeSwatches = (swatches: string[]) => {
			if (y >= rect.y + rect.h) return;
			const cell = 2;
			const fit  = Math.min(swatches.length, Math.floor((rect.w - 2) / cell));
			let x = rect.x + 2;
			for (let i = 0; i < fit; i++) {
				scr.fillRect(x, y, cell, 1, { type: 'hex', value: swatches[i] });
				x += cell;
			}
			y++;
		};

		writeLine(colorFg(theme.fg) + ansi.bold + ' You' + ansi.reset);
		writeSwatches(fps.local.swatches);
		writeLine(colorFg(theme.disabled) + '  ' + truncate(fps.local.hex, rect.w - 2) + ansi.reset);
		y++; // blank line

		if (fps.peers.length === 0) {
			writeLine(colorFg(theme.disabled) + '  (no peers yet)' + ansi.reset);
			return;
		}

		for (const p of fps.peers) {
			if (y >= rect.y + rect.h) break;
			writeLine(colorFg(theme.peerName) + ansi.bold + ' ' + truncate(sanitizeTerminal(p.username), rect.w - 1) + ansi.reset);
			writeSwatches(p.fingerprint.swatches);
			writeLine(colorFg(theme.disabled) + '  ' + truncate(p.fingerprint.hex, rect.w - 2) + ansi.reset);
			y++;
		}
	}

	onKey(key: Key): boolean {
		if (this.mode !== 'event-log') {
			// Verify panel is read-only; consume nothing.
			return false;
		}
		if (key.name === 'up')       {
			this._move(-1); return true;
		}
		if (key.name === 'down')     {
			this._move(+1); return true;
		}
		if (key.name === 'pageup')   {
			this._scrollPage(-1); return true;
		}
		if (key.name === 'pagedown') {
			this._scrollPage(+1); return true;
		}
		if (key.name === 'home')     {
			this.scrollTop = 0; this.autoScroll = false;
			const events = getEvents();
			this.selectedId = events.length > 0 ? events[0].id : null;
			return true;
		}
		if (key.name === 'end')      {
			this.autoScroll = true;
			const events = getEvents();
			this.selectedId = events.length > 0 ? events[events.length - 1].id : null;
			return true;
		}
		if (key.name === 'enter')    {
			this._toggleExpanded(); return true;
		}
		return false;
	}

	private _move(dir: -1 | 1): void {
		const events = getEvents();
		if (events.length === 0) {
			this.selectedId = null; return;
		}
		const ids = events.map(e => e.id);
		if (this.selectedId === null) {
			this.selectedId = dir > 0 ? ids[0] : ids[ids.length - 1];
		} else {
			const i = ids.indexOf(this.selectedId);
			if (i < 0)             this.selectedId = ids[ids.length - 1];
			else if (dir > 0)      this.selectedId = ids[Math.min(i + 1, ids.length - 1)];
			else                   this.selectedId = ids[Math.max(i - 1, 0)];
		}
		// Disable autoScroll while user is navigating; the render will keep selection in view.
		this.autoScroll = false;
		this._ensureSelectionVisible();
	}

	private _ensureSelectionVisible(): void {
		const onScreen = this.rendered.some(r => r.entryId === this.selectedId && r.isHeader);
		if (onScreen) return;
		// Selection is off-screen: page toward it. At the top we can only page
		// down; otherwise page up.
		this._scrollPage(this.scrollTop === 0 ? +1 : -1);
	}

	private _scrollPage(dir: -1 | 1): void {
		const h = Math.max(1, this.rect.h - 1);
		if (dir > 0) {
			this.scrollTop = Math.min(this.scrollTop + Math.max(1, h - 1), Math.max(0, this.totalLines - h));
			if (this.scrollTop >= Math.max(0, this.totalLines - h)) this.autoScroll = true;
		} else {
			this.scrollTop = Math.max(0, this.scrollTop - Math.max(1, h - 1));
			this.autoScroll = false;
		}
	}

	private _toggleExpanded(): void {
		if (this.selectedId === null) return;
		if (this.expanded.has(this.selectedId)) this.expanded.delete(this.selectedId);
		else this.expanded.add(this.selectedId);
		this._scrollSelectedEntryIntoView();
	}

	// After expand/collapse, scroll down if the selected entry's last detail
	// line sits below the viewport. The selection cursor stays on the header,
	// so without this the bottom-most entry's details have no anchor the user
	// can navigate to.
	private _scrollSelectedEntryIntoView(): void {
		if (this.selectedId === null) return;
		const events = getEvents();
		const h      = Math.max(1, this.rect.h - 1);
		let total    = 0;
		let lastLine = -1;
		for (const e of events) {
			total += 1;
			if (this.expanded.has(e.id)) total += Object.keys(e.details).length;
			if (e.id === this.selectedId) lastLine = total - 1;
		}
		if (lastLine < 0) return;
		if (lastLine >= this.scrollTop + h) {
			const max      = Math.max(0, total - h);
			this.scrollTop = Math.min(lastLine - h + 1, max);
			if (this.scrollTop >= max) this.autoScroll = true;
		}
	}

	stepWidth(direction: -1 | 1): number {
		return this.setWidth(this.width + direction * SIDEBAR_WIDTH_STEP);
	}

	// Mouse-wheel routing: scroll the event log line-by-line. No-op on verify.
	scrollByLines(delta: number): void {
		if (this.mode !== 'event-log') return;
		const h = Math.max(1, this.rect.h - 1);
		const max = Math.max(0, this.totalLines - h);
		this.scrollTop = Math.max(0, Math.min(this.scrollTop + delta, max));
		if (delta < 0)        this.autoScroll = false;
		if (this.scrollTop >= max) this.autoScroll = true;
	}
}
