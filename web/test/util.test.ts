import { describe, expect, test } from 'bun:test';
import { clear, el, formatBytes, senderColor, senderIndex } from '../src/util.ts';

describe('el', () => {
	test('creates a tagged element', () => {
		const div = el('div');
		expect(div.tagName).toBe('DIV');
		expect(div.className).toBe('');
		expect(div.textContent).toBe('');
	});

	test('applies class and text', () => {
		const p = el('p', 'foo bar', 'hello');
		expect(p.className).toBe('foo bar');
		expect(p.textContent).toBe('hello');
	});

	test('sets text via textContent (no markup parsing)', () => {
		const span = el('span', undefined, '<b>x</b>');
		expect(span.textContent).toBe('<b>x</b>');
		expect(span.querySelector('b')).toBeNull();
	});
});

describe('clear', () => {
	test('removes all children', () => {
		const ul = el('ul');
		ul.append(el('li'), el('li'), el('li'));
		expect(ul.children.length).toBe(3);
		clear(ul);
		expect(ul.children.length).toBe(0);
	});
});

describe('formatBytes', () => {
	test('bytes under 1KiB', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(1023)).toBe('1023 B');
	});
	test('KiB / MiB / GiB boundaries', () => {
		expect(formatBytes(1024)).toBe('1.0 KB');
		expect(formatBytes(1536)).toBe('1.5 KB');
		expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
		expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
	});
});

describe('senderColor', () => {
	test('maps index into the 8-slot palette', () => {
		expect(senderColor(0)).toBe('var(--sender-0)');
		expect(senderColor(7)).toBe('var(--sender-7)');
		expect(senderColor(8)).toBe('var(--sender-0)');
		expect(senderColor(10)).toBe('var(--sender-2)');
	});
});

describe('senderIndex', () => {
	test('assigns stable incrementing indices per username', () => {
		const known = new Map<string, number>();
		expect(senderIndex('a', known)).toBe(0);
		expect(senderIndex('b', known)).toBe(1);
		expect(senderIndex('a', known)).toBe(0);
		expect(known.size).toBe(2);
	});
});
