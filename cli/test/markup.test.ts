import { describe, expect, test } from 'bun:test';
import { sanitizeTerminal, messageToLines, ScrollView, Sidebar } from '../src/tui/widgets.ts';
import { defaultTheme, ansi, colorFg, colorBg } from '../src/tui/screen.ts';
import type { Screen } from '../src/tui/screen.ts';
import type { Key } from '../src/tui/keys.ts';
import { logEvent, resetEvents } from '../src/eventLog.ts';

// Captures everything a widget writes to the terminal so we can assert no peer
// escape sequence ever reaches process.stdout. fillRect/moveTo are no-ops; only
// write() carries the styled text we care about.
class FakeScreen {
	writes: string[] = [];
	fillRect(): void {
		/* no-op: only write() output is asserted */
	}
	moveTo(): void {
		/* no-op */
	}
	write(s: string): void {
		this.writes.push(s);
	}
	out(): string {
		return this.writes.join('');
	}
}
const asScreen = (f: FakeScreen): Screen => f as unknown as Screen;

// The CLI renders raw bytes to the terminal, so peer-controlled escape sequences
// are the live threat. sanitizeTerminal must neutralize them while leaving the
// ASCII markup markers (* _ `) and newlines intact for parseMarkup.

describe('sanitizeTerminal', () => {
	test('strips an OSC 52 clipboard-write sequence', () => {
		expect(sanitizeTerminal('\x1b]52;c;AAAA\x07hello')).toBe('hello');
	});
	test('strips OSC terminated by ST (ESC backslash)', () => {
		expect(sanitizeTerminal('\x1b]0;pwned\x1b\\x')).toBe('x');
	});
	test('strips a clear-screen CSI', () => {
		expect(sanitizeTerminal('\x1b[2Jhello')).toBe('hello');
	});
	test('strips an SGR color CSI', () => {
		expect(sanitizeTerminal('\x1b[31mred\x1b[0m')).toBe('red');
	});
	test('strips a two-char escape', () => {
		expect(sanitizeTerminal('\x1bMrest')).toBe('rest');
	});
	test('strips stray control chars and DEL', () => {
		expect(sanitizeTerminal('a\x07b\x00c\x7fd')).toBe('abcd');
	});
	test('strips html-ish tags for defensive parity', () => {
		expect(sanitizeTerminal('<img src=x onerror=alert(1)>hi')).toBe('hi');
	});
	test('preserves newlines so blocks survive into the parser', () => {
		expect(sanitizeTerminal('a\nb')).toBe('a\nb');
	});
	test('preserves markup markers', () => {
		expect(sanitizeTerminal('*_`x`_*')).toBe('*_`x`_*');
	});
	test('strips bidi controls and zero-width spoofing chars', () => {
		const rlo = String.fromCodePoint(0x202e), zwsp = String.fromCodePoint(0x200b);
		expect(sanitizeTerminal(`ev${rlo}il${zwsp}x`)).toBe('evilx');
	});
	test('keeps ZWJ so emoji sequences survive', () => {
		const zwj = String.fromCodePoint(0x200d);
		expect(sanitizeTerminal(`a${zwj}b`)).toBe(`a${zwj}b`);
	});
});

describe('messageToLines: SGR emission', () => {
	const reset = ansi.reset;

	test('bold emits the base fg + bold opener and a reset', () => {
		const lines = messageToLines('*bold*', 40, '', defaultTheme);
		expect(lines).toEqual([ansi.bold + 'bold' + reset]);
	});
	test('italic emits the italic opener', () => {
		const lines = messageToLines('_it_', 40, '', defaultTheme);
		expect(lines).toEqual([ansi.italic + 'it' + reset]);
	});
	test('bold+italic emits both openers', () => {
		const lines = messageToLines('_*x*_', 40, '', defaultTheme);
		expect(lines).toEqual([ansi.bold + ansi.italic + 'x' + reset]);
	});
	test('inline code emits the code bg/fg swatch', () => {
		const codeSeq = colorBg(defaultTheme.codeBg) + colorFg(defaultTheme.codeFg);
		const lines   = messageToLines('`c`', 40, '', defaultTheme);
		expect(lines).toEqual([codeSeq + 'c' + reset]);
	});
	test('a fenced block is a padded code-fill line that preserves spacing', () => {
		const codeSeq = colorBg(defaultTheme.codeBg) + colorFg(defaultTheme.codeFg);
		const lines   = messageToLines('```\n a b\n```', 6, '', defaultTheme);
		// content ' a b' (4 wide) padded to width 6 → ' a b  '
		expect(lines).toEqual([codeSeq + ' a b  ' + reset]);
	});
	test('a wide fenced line wraps at the column boundary, never clipped', () => {
		const lines = messageToLines('```\nabcdef\n```', 4, '', defaultTheme);
		// 'abcdef' hard-wraps into 'abcd' + 'ef  ' (both padded to 4)
		expect(lines.length).toBe(2);
		expect(lines[0]).toContain('abcd');
		expect(lines[1]).toContain('ef');
	});
	test('a fenced block wraps on display columns, never severing a surrogate pair', () => {
		// 👍 is one code point but two terminal columns. At width 2 each emoji fills
		// a row on its own, and stepping over whole code points means no row ever
		// holds a lone surrogate. Three emoji → three rows.
		const lines   = messageToLines('```\n👍👍👍\n```', 2, '', defaultTheme);
		const visible = lines.join('');
		expect(lines.length).toBe(3);
		expect([...visible].filter(c => c === '👍').length).toBe(3);
		expect(visible).not.toContain('�');
	});
	test('a fenced block pads wide CJK glyphs by column count, not code-point count', () => {
		const codeSeq = colorBg(defaultTheme.codeBg) + colorFg(defaultTheme.codeFg);
		// '中文' is two code points but four columns, so width 6 pads with two spaces.
		const lines   = messageToLines('```\n中文\n```', 6, '', defaultTheme);
		expect(lines).toEqual([codeSeq + '中文  ' + reset]);
	});
	test('a wide fenced line wraps when the next glyph would overflow the column', () => {
		// '中文' is four columns; at width 3 the second glyph cannot fit beside the
		// first, so it drops to its own row (each padded to width 3).
		const lines = messageToLines('```\n中文\n```', 3, '', defaultTheme);
		expect(lines.length).toBe(2);
		expect(lines[0]).toContain('中');
		expect(lines[1]).toContain('文');
	});
	test('a paragraph hard-wraps wide CJK on display columns, not code-point count', () => {
		// '中文中文' is one space-free word of eight columns; at width 4 it splits
		// two glyphs per row rather than four code points per row.
		const lines = messageToLines('中文中文', 4, '', defaultTheme);
		expect(lines.length).toBe(2);
		expect(lines[0]).toContain('中文');
		expect(lines[1]).toContain('中文');
	});
});

describe('messageToLines: injection is neutralized end to end', () => {
	test('peer escapes never reach the terminal; only our SGR is emitted', () => {
		const payload = '\x1b]52;c;QUFBQQ==\x07\x1b[2J*hi*';
		const out     = messageToLines(payload, 40, '', defaultTheme).join('\n');
		expect(out).toBe(ansi.bold + 'hi' + ansi.reset);
		expect(out.includes(']52')).toBe(false);
		expect(out.includes('[2J')).toBe(false);
	});
});

describe('ScrollView: peer-controlled sender/filename are sanitized', () => {
	const rect = { x: 0, y: 0, w: 40, h: 10 };

	test('a malicious sender name cannot drive the terminal', () => {
		const sv = new ScrollView('msgs');
		sv.addMessage({ sender: 'evil\x1b]52;c;AAAA\x07\x1b[2J', text: 'hi', isSelf: false, senderIndex: 1 });
		const scr = new FakeScreen();
		sv.render(asScreen(scr), rect, true, defaultTheme);
		const out = scr.out();
		expect(out.includes(']52')).toBe(false);
		expect(out.includes('[2J')).toBe(false);
		expect(out.includes('evil')).toBe(true);  // stripped name still shown
		expect(out.includes('hi')).toBe(true);     // body still rendered
	});

	test('a malicious filename cannot drive the terminal', () => {
		const sv = new ScrollView('msgs');
		sv.addFile({ sender: 'bob', filename: 'a\x1b[2Jb.png', size: 10, mime: 'image/png', isSelf: false, senderIndex: 1, download: () => Promise.resolve('') });
		const scr = new FakeScreen();
		sv.render(asScreen(scr), rect, true, defaultTheme);
		const out = scr.out();
		expect(out.includes('[2J')).toBe(false);
		expect(out.includes('ab.png')).toBe(true);
	});
});

describe('Sidebar verify pane: peer username is sanitized', () => {
	test('a malicious peer username cannot drive the terminal', () => {
		const sb = new Sidebar(
			30,
			() => ({
				local: { swatches: [], hex: '00', badge: '#000000' },
				peers: [{ username: 'eve\x1b[2Jx', fingerprint: { swatches: [], hex: 'ff', badge: '#ffffff' }, colorIdx: 1 }],
			}),
			'me',
		);
		sb.setMode('verify');
		const scr = new FakeScreen();
		sb.render(asScreen(scr), { x: 0, y: 0, w: 30, h: 20 }, false, defaultTheme);
		const out = scr.out();
		expect(out.includes('[2J')).toBe(false);
		expect(out.includes('evex')).toBe(true);
	});
});

// Event-log detail KEYS are peer-influenced too: a broadcast's `meta.<name>` keys
// flow into e.details unvalidated (the server control-char-rejects only usernames).
// Expanding such an event must not let the key's escapes reach the terminal.
describe('Sidebar event-log: peer-controlled detail keys are sanitized', () => {
	const key = (name: string): Key => ({ name } as unknown as Key);
	const noFingerprints = () => ({ local: { swatches: [], hex: '', badge: '#000000' }, peers: [] });

	test('an escape in a broadcast meta key is stripped when the event is expanded', () => {
		resetEvents();
		logEvent({
			direction: 'in',
			kind: 'broadcast',
			summary: 'bob broadcast',
			details: { 'meta.\x1b[2Jevil': 'v' },
		});

		const sb = new Sidebar(40, noFingerprints, 'me');
		sb.setMode('event-log');
		sb.onKey(key('end'));    // select the only entry
		sb.onKey(key('enter'));  // expand it → details render

		const scr = new FakeScreen();
		sb.render(asScreen(scr), { x: 0, y: 0, w: 40, h: 20 }, true, defaultTheme);
		const out = scr.out();

		expect(out.includes('\x1b[2J')).toBe(false);
		expect(out.includes('[2J')).toBe(false);
		expect(out.includes('meta.evil')).toBe(true);  // key shown, escape stripped
		resetEvents();
	});
});
