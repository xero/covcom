import { describe, expect, test } from 'bun:test';
import { clear, el, formatBytes, peerColor } from '../src/util.ts';

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

describe('peerColor', () => {
	test('self (colorIdx 0) is reserved peer0', () => {
		expect(peerColor(0)).toBe('var(--peer0)');
	});
	test('peers cycle peer1..peer7, never landing on peer0', () => {
		expect(peerColor(1)).toBe('var(--peer1)');
		expect(peerColor(7)).toBe('var(--peer7)');
		expect(peerColor(8)).toBe('var(--peer1)');   // wraps after 7, not to peer0
		expect(peerColor(14)).toBe('var(--peer7)');
		expect(peerColor(15)).toBe('var(--peer1)');
	});
});
