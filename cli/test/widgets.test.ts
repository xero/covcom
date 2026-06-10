import { describe, expect, test } from 'bun:test';
import { Button, TextArea, TextInput, layoutModal, MODAL_MIN_INNER } from '../src/tui/widgets.ts';
import type { Key } from '../src/tui/keys.ts';

const key = (name: string, opts: Partial<Key> = {}): Key => ({ name, ch: opts.ch, ctrl: opts.ctrl ?? false, shift: opts.shift ?? false, meta: opts.meta ?? false });
const ch = (c: string): Key => key(c, { ch: c });

describe('TextInput.onKey', () => {
	test('inserts printable chars at the cursor', () => {
		const t = new TextInput('i');
		t.onKey(ch('h')); t.onKey(ch('i'));
		expect(t.value).toBe('hi');
		expect(t.cursor).toBe(2);
	});

	test('left/right move the cursor and bound at edges', () => {
		const t = new TextInput('i', 'ab');
		t.onKey(key('left')); expect(t.cursor).toBe(1);
		t.onKey(key('left')); t.onKey(key('left')); expect(t.cursor).toBe(0);
		t.onKey(key('right')); expect(t.cursor).toBe(1);
	});

	test('backspace deletes the char before the cursor', () => {
		const t = new TextInput('i', 'abc');
		t.onKey(key('left'));            // cursor at 2
		t.onKey(key('backspace'));       // remove 'b'
		expect(t.value).toBe('ac');
		expect(t.cursor).toBe(1);
	});

	test('delete removes the char at the cursor', () => {
		const t = new TextInput('i', 'abc');
		t.onKey(key('home'));
		t.onKey(key('delete'));
		expect(t.value).toBe('bc');
	});

	test('home / end jump to the ends', () => {
		const t = new TextInput('i', 'abc');
		t.onKey(key('home')); expect(t.cursor).toBe(0);
		t.onKey(key('end'));  expect(t.cursor).toBe(3);
	});

	test('enter propagates to the view (returns false)', () => {
		expect(new TextInput('i').onKey(key('enter'))).toBe(false);
	});

	test('paste inserts text with newlines stripped', () => {
		const t = new TextInput('i', 'ab');
		t.onKey(key('home'));
		t.onPaste('X\nY');
		expect(t.value).toBe('XYab');
	});
});

describe('TextArea.onKey', () => {
	test('enter inserts a newline (does not propagate)', () => {
		const t = new TextArea('a', 'ab');
		expect(t.onKey(key('enter'))).toBe(true);
		expect(t.value).toBe('ab\n');
	});

	test('up/down move between lines preserving column', () => {
		const t = new TextArea('a', 'foo\nbarbar');
		t.onKey(key('end'));             // end of line 2 (cursor at 10)
		t.onKey(key('up'));              // to line 1, clamped to its length (3)
		expect(t.value.slice(0, t.cursor)).toBe('foo');
	});

	test('paste keeps newlines', () => {
		const t = new TextArea('a');
		t.onPaste('x\ny');
		expect(t.value).toBe('x\ny');
	});
});

describe('Button.onKey', () => {
	test('enter fires the action', () => {
		let fired = 0;
		const b = new Button('b', 'Go', () => fired++);
		expect(b.onKey(key('enter'))).toBe(true);
		expect(fired).toBe(1);
	});

	test('disabled button ignores enter and click', () => {
		let fired = 0;
		const b = new Button('b', 'Go', () => fired++, true);
		expect(b.onKey(key('enter'))).toBe(false);
		b.onClick();
		expect(fired).toBe(0);
	});
});

describe('layoutModal', () => {
	const longBody = 'word '.repeat(80).trim();  // ~400 cols of wrappable text

	test('short body holds the minimum inner width, even on a wide terminal', () => {
		expect(layoutModal(200, 'ok', 'hi').innerW).toBe(MODAL_MIN_INNER);
	});

	test('a title wider than the minimum widens the box', () => {
		const title = 'x'.repeat(40);
		expect(layoutModal(120, title, 'hi').innerW).toBe(40);
	});

	test('long body wraps wider as the terminal grows', () => {
		const at80  = layoutModal(80, 'title', longBody);
		const at200 = layoutModal(200, 'title', longBody);
		// every wrapped line stays within the scaled wrap target (floor(w * 0.6))
		expect(Math.max(...at80.lines.map((l) => l.length))).toBeLessThanOrEqual(48);
		expect(Math.max(...at200.lines.map((l) => l.length))).toBeLessThanOrEqual(120);
		// wider terminal => wider box and fewer wrapped lines
		expect(at200.innerW).toBeGreaterThan(at80.innerW);
		expect(at200.lines.length).toBeLessThan(at80.lines.length);
		// and it actually scales past the old fixed 24-column behavior
		expect(at80.innerW).toBeGreaterThan(MODAL_MIN_INNER);
	});

	test('a tiny terminal caps the width below the minimum rather than overflowing', () => {
		// maxInner = w - 12 = 18, which is below MODAL_MIN_INNER
		expect(layoutModal(30, 'title', longBody).innerW).toBe(18);
	});
});
