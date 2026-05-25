import { describe, expect, test } from 'bun:test';
import { FocusRing } from '../src/tui/focus.ts';

describe('FocusRing', () => {
	test('empty ring is safe and current() is empty string', () => {
		const r = new FocusRing();
		expect(r.current()).toBe('');
		r.next();
		r.prev();
		expect(r.current()).toBe('');
		expect(r.isFocused('anything')).toBe(false);
	});

	test('starts focused on the first registered item', () => {
		const r = new FocusRing();
		r.register('a');
		r.register('b');
		expect(r.current()).toBe('a');
		expect(r.isFocused('a')).toBe(true);
		expect(r.isFocused('b')).toBe(false);
	});

	test('next wraps around', () => {
		const r = new FocusRing();
		r.register('a'); r.register('b'); r.register('c');
		r.next(); expect(r.current()).toBe('b');
		r.next(); expect(r.current()).toBe('c');
		r.next(); expect(r.current()).toBe('a');
	});

	test('prev wraps around', () => {
		const r = new FocusRing();
		r.register('a'); r.register('b');
		r.prev(); expect(r.current()).toBe('b');
		r.prev(); expect(r.current()).toBe('a');
	});

	test('setById focuses a known id, ignores unknown', () => {
		const r = new FocusRing();
		r.register('a'); r.register('b');
		r.setById('b');
		expect(r.current()).toBe('b');
		r.setById('missing');
		expect(r.current()).toBe('b');
	});

	test('clear resets items and index', () => {
		const r = new FocusRing();
		r.register('a'); r.register('b');
		r.next();
		r.clear();
		expect(r.current()).toBe('');
		r.register('x');
		expect(r.current()).toBe('x');
	});
});
