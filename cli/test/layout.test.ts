import { describe, expect, test } from 'bun:test';
import { chatLayout, chatFocusIds, keyHints } from '../src/tui/views.ts';
import { FocusRing } from '../src/tui/focus.ts';
import { SIDEBAR_MIN_COLS } from '../src/config.ts';

describe('chatLayout', () => {
	test('closed sidebar gives chat the full width at any size', () => {
		expect(chatLayout(false, 200, 30)).toEqual({ mode: 'chat', sideW: 0, chatW: 200 });
		expect(chatLayout(false, 40,  30)).toEqual({ mode: 'chat', sideW: 0, chatW: 40  });
	});

	test('open on a narrow terminal takes the full width, hiding chat', () => {
		expect(chatLayout(true, 60, 30)).toEqual({ mode: 'full', sideW: 60, chatW: 0 });
		expect(chatLayout(true, 79, 30)).toEqual({ mode: 'full', sideW: 79, chatW: 0 });
	});

	test('open on a wide terminal splits side-by-side, reserving the separator', () => {
		// 30% of 100 = 30, within [10, 100-24=76]
		expect(chatLayout(true, 100, 30)).toEqual({ mode: 'side', sideW: 30, chatW: 69 });
	});

	test('side width clamps to a 10-col floor for tiny percentages', () => {
		// 5% of 100 = 5 -> floored up to 10
		expect(chatLayout(true, 100, 5)).toEqual({ mode: 'side', sideW: 10, chatW: 89 });
	});

	test('side width clamps to cols-24 ceiling for large percentages', () => {
		// 90% of 100 = 90 -> capped at 100-24 = 76
		expect(chatLayout(true, 100, 90)).toEqual({ mode: 'side', sideW: 76, chatW: 23 });
	});

	test('the 80-col boundary divides full from side', () => {
		expect(chatLayout(true, SIDEBAR_MIN_COLS - 1, 30).mode).toBe('full');
		expect(chatLayout(true, SIDEBAR_MIN_COLS,     30).mode).toBe('side');
	});
});

describe('chatFocusIds', () => {
	test('picking reduces the ring to the path input and cancel button', () => {
		expect(chatFocusIds('chat', true)).toEqual(['pathInput', 'cancelBtn']);
		expect(chatFocusIds('full', true)).toEqual(['pathInput', 'cancelBtn']);
		expect(chatFocusIds('side', true)).toEqual(['pathInput', 'cancelBtn']);
	});

	test('full-width sidebar exposes only the sidebar (chat widgets hidden)', () => {
		expect(chatFocusIds('full', false)).toEqual(['sidebar']);
	});

	test('side-by-side includes the chat widgets and the sidebar', () => {
		expect(chatFocusIds('side', false)).toEqual([
			'chatInput', 'sendBtn', 'attachBtn', 'rotateBtn', 'msgArea', 'sidebar',
		]);
	});

	test('chat-only omits the sidebar', () => {
		expect(chatFocusIds('chat', false)).toEqual([
			'chatInput', 'sendBtn', 'attachBtn', 'rotateBtn', 'msgArea',
		]);
	});
});

describe('keyHints', () => {
	test('the four units come back in render order with their keys', () => {
		expect(keyHints({}).map(h => [h.key, h.label])).toEqual([
			['R',   'ratchet'],
			['E',   'events'],
			['V',   'verify'],
			['ESC', 'return to chat'],
		]);
	});

	test('icons are absent when the config defines none (no default)', () => {
		expect(keyHints({}).every(h => h.icon === undefined)).toBe(true);
		// ratchet has a bar-button default of "R", but the keys-display reads raw.
		expect(keyHints({ icons: {} }).every(h => h.icon === undefined)).toBe(true);
	});

	test('configured icons surface; unset ones stay absent', () => {
		const hints = keyHints({ icons: { ratchet: 'r', verify: 'v' } });
		expect(hints[0].icon).toBe('r');
		expect(hints[1].icon).toBeUndefined();
		expect(hints[2].icon).toBe('v');
		expect(hints[3].icon).toBeUndefined();
	});

	test('whitespace-only icons are treated as unset', () => {
		expect(keyHints({ icons: { events: '   ' } })[1].icon).toBeUndefined();
	});
});

describe('focus ring composition from chatFocusIds', () => {
	const fill = (ids: string[]): FocusRing => {
		const r = new FocusRing();
		for (const id of ids) r.register(id);
		return r;
	};

	test('full-width ring parks on the sidebar with nothing to cycle', () => {
		const r = fill(chatFocusIds('full', false));
		expect(r.current()).toBe('sidebar');
		r.next(); expect(r.current()).toBe('sidebar');
		r.prev(); expect(r.current()).toBe('sidebar');
	});

	test('side-by-side ring cycles chat widgets then the sidebar and wraps', () => {
		const r = fill(chatFocusIds('side', false));
		expect(r.current()).toBe('chatInput');
		r.next(); expect(r.current()).toBe('sendBtn');
		r.next(); expect(r.current()).toBe('attachBtn');
		r.next(); expect(r.current()).toBe('rotateBtn');
		r.next(); expect(r.current()).toBe('msgArea');
		r.next(); expect(r.current()).toBe('sidebar');
		r.next(); expect(r.current()).toBe('chatInput');
	});
});
