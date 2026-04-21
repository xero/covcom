import { formatBytes } from '../util.js';
import { Screen, Theme, ColorValue, colorFg, colorBg, ansi } from './screen.js';
import type { Key } from './keys.js';

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

export function wordWrap(text: string, width: number): string[] {
	if (width <= 0) return [text];
	const words  = text.split(' ');
	const lines: string[] = [];
	let cur = '';
	for (const word of words) {
		if (word.length > width) {
			if (cur) {
				lines.push(cur);
			}
			let w = word;
			while (w.length > width) {
				lines.push(w.slice(0, width)); w = w.slice(width);
			}
			cur = w;
			continue;
		}
		const needed = cur ? cur.length + 1 + word.length : word.length;
		if (needed > width) {
			lines.push(cur); cur = word;
		} else cur = cur ? cur + ' ' + word : word;
	}
	if (cur) lines.push(cur);
	return lines.length ? lines : [''];
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
	| { isFile: true; sender: string; filename: string; size: number; mime: string; isSelf: boolean; senderIndex: number; saved?: string }

interface RenderedLine {
	screenY:     number
	attachment?: { filename: string; chipX1: number; chipX2: number; saved?: string }
}

export class ScrollView implements Widget {
	id:     string;
	rect:   Rect = { x: 0, y: 0, w: 0, h: 0 };

	private msgs:          StoredMsg[] = [];
	private scrollTop      = 0;
	private autoScroll     = true;
	private totalLines     = 0;
	private renderedLines: RenderedLine[] = [];

	constructor(id: string) {
		this.id = id;
	}

	addMessage(msg: { sender: string; text: string; isSelf: boolean; senderIndex: number }) {
		this.msgs.push({ isFile: false, ...msg });
	}

	addFile(msg: { sender: string; filename: string; size: number; mime: string; isSelf: boolean; senderIndex: number; saved?: string }) {
		this.msgs.push({ isFile: true, ...msg });
	}

	private computeLines(lineW: number, theme: Theme) {
		interface ComputedLine { text: string; attachment?: RenderedLine['attachment'] }
		const result: ComputedLine[] = [];

		for (const msg of this.msgs) {
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
				const textLines = msg.text.split('\n');
				for (let ti = 0; ti < textLines.length; ti++) {
					const wrapped = wordWrap(textLines[ti], Math.max(lineW - prefixLen, 10));
					const head    = ti === 0;
					for (let wi = 0; wi < wrapped.length; wi++) {
						if (head && wi === 0) {
							result.push({ text: nameFg + msg.sender + ansi.reset + ': ' + textFg + wrapped[wi] + ansi.reset });
						} else {
							result.push({ text: ' '.repeat(prefixLen) + textFg + wrapped[wi] + ansi.reset });
						}
					}
				}
				if (result.length === 0 || (result[result.length - 1]?.text === '' )) {
					// ensure at least one line
				}
			} else {
				const chip    = ` ${msg.filename} `;
				const chipX1  = prefixLen;        // relative to line start
				const chipX2  = chipX1 + chip.length - 1;
				const size    = formatBytes(msg.size);
				const line    = nameFg + msg.sender + ansi.reset + ':'
				              + colorBg(theme.attachBg) + colorFg(theme.attachFg) + chip + ansi.reset
				              + colorFg(theme.disabled) + ` (${size})` + ansi.reset;
				result.push({
					text: line,
					attachment: { filename: msg.filename, chipX1, chipX2, saved: msg.saved },
				});
			}
		}
		return result;
	}

	render(scr: Screen, rect: Rect, _focused: boolean, theme: Theme) {
		this.rect         = rect;
		this.renderedLines = [];

		const lineW   = rect.w - 1;  // reserve right col for scroll indicator
		const allLines = this.computeLines(lineW, theme);
		this.totalLines   = allLines.length;

		if (this.autoScroll)
			this.scrollTop = Math.max(0, this.totalLines - rect.h);
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, this.totalLines - rect.h)));

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

	onKey(key: Key): boolean {
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
