import { describe, expect, test } from 'bun:test';
import { parseInput } from '../src/tui/keys.ts';

const buf = (s: string) => Buffer.from(s, 'binary');

describe('parseInput: escape sequences', () => {
	test('arrow keys (CSI and SS3 forms)', () => {
		expect(parseInput(buf('\x1b[A'))).toEqual({ kind: 'key', key: { name: 'up', ch: undefined, ctrl: false, shift: false, meta: false } });
		expect(parseInput(buf('\x1bOB'))).toMatchObject({ kind: 'key', key: { name: 'down' } });
		expect(parseInput(buf('\x1b[C'))).toMatchObject({ key: { name: 'right' } });
		expect(parseInput(buf('\x1b[D'))).toMatchObject({ key: { name: 'left' } });
	});

	test('shift+tab, home, end, page nav, delete, insert', () => {
		expect(parseInput(buf('\x1b[Z'))).toMatchObject({ key: { name: 'tab', shift: true } });
		expect(parseInput(buf('\x1b[H'))).toMatchObject({ key: { name: 'home' } });
		expect(parseInput(buf('\x1b[4~'))).toMatchObject({ key: { name: 'end' } });
		expect(parseInput(buf('\x1b[5~'))).toMatchObject({ key: { name: 'pageup' } });
		expect(parseInput(buf('\x1b[6~'))).toMatchObject({ key: { name: 'pagedown' } });
		expect(parseInput(buf('\x1b[3~'))).toMatchObject({ key: { name: 'delete' } });
		expect(parseInput(buf('\x1b[2~'))).toMatchObject({ key: { name: 'insert' } });
	});

	test('standalone escape', () => {
		expect(parseInput(buf('\x1b'))).toMatchObject({ key: { name: 'escape' } });
	});
});

describe('parseInput: control characters', () => {
	test('enter, tab, backspace', () => {
		expect(parseInput(buf('\r'))).toMatchObject({ key: { name: 'enter' } });
		expect(parseInput(buf('\r\n'))).toMatchObject({ key: { name: 'enter' } });
		expect(parseInput(buf('\t'))).toMatchObject({ key: { name: 'tab' } });
		expect(parseInput(buf('\x7f'))).toMatchObject({ key: { name: 'backspace' } });
		expect(parseInput(buf('\x08'))).toMatchObject({ key: { name: 'backspace', ctrl: true } });
	});

	test('ctrl+letter maps byte to letter with ctrl flag', () => {
		expect(parseInput(buf('\x03'))).toMatchObject({ key: { name: 'c', ctrl: true, ch: 'c' } }); // ^C
		expect(parseInput(buf('\x01'))).toMatchObject({ key: { name: 'a', ctrl: true, ch: 'a' } }); // ^A
	});
});

describe('parseInput: printable text', () => {
	test('single printable char is a keypress', () => {
		expect(parseInput(buf('x'))).toEqual({ kind: 'key', key: { name: 'x', ch: 'x', ctrl: false, shift: false, meta: false } });
	});

	test('multi-char input is an unbracketed paste', () => {
		expect(parseInput(buf('hello'))).toEqual({ kind: 'paste', text: 'hello' });
	});

	test('multi-byte UTF-8 single codepoint is a keypress', () => {
		const e = parseInput(Buffer.from('é', 'utf8'));
		expect(e).toEqual({ kind: 'key', key: { name: 'é', ch: 'é', ctrl: false, shift: false, meta: false } });
	});
});

describe('parseInput: mouse (SGR)', () => {
	test('click', () => {
		expect(parseInput(buf('\x1b[<0;12;34M'))).toEqual({ kind: 'mouse', mouse: { type: 'click', button: 0, x: 12, y: 34 } });
	});

	test('release (lowercase m)', () => {
		expect(parseInput(buf('\x1b[<0;12;34m'))).toMatchObject({ kind: 'mouse', mouse: { type: 'release' } });
	});

	test('scroll (button >= 64)', () => {
		expect(parseInput(buf('\x1b[<64;1;1M'))).toMatchObject({ kind: 'mouse', mouse: { type: 'scroll', button: 64 } });
	});
});

describe('parseInput: bracketed paste', () => {
	test('extracts text between paste markers', () => {
		expect(parseInput(buf('\x1b[200~pasted text\x1b[201~'))).toEqual({ kind: 'paste', text: 'pasted text' });
	});

	test('handles paste without closing marker', () => {
		expect(parseInput(buf('\x1b[200~tail'))).toEqual({ kind: 'paste', text: 'tail' });
	});
});
