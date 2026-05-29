import { describe, expect, test } from 'bun:test';
import { Button, TextArea, TextInput } from '../src/tui/widgets.ts';
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
