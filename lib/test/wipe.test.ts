import { describe, expect, test } from 'bun:test';
import { wipe } from '../src/wipe.js';

describe('wipe', () => {
	test('zeroes every byte of a buffer', () => {
		const buf = new Uint8Array([1, 2, 3, 4, 255]);
		wipe(buf);
		expect([...buf]).toEqual([0, 0, 0, 0, 0]);
	});

	test('handles an empty buffer without throwing', () => {
		expect(() => wipe(new Uint8Array(0))).not.toThrow();
	});

	test('only clears the given view, not the backing buffer', () => {
		const backing = new Uint8Array([1, 2, 3, 4]);
		const view    = backing.subarray(1, 3);
		wipe(view);
		expect([...backing]).toEqual([1, 0, 0, 4]);
	});

	test('is idempotent on an already-zeroed buffer', () => {
		const buf = new Uint8Array(8);
		wipe(buf);
		wipe(buf);
		expect(buf.every(b => b === 0)).toBe(true);
	});
});
