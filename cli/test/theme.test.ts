import { describe, expect, test } from 'bun:test';
import { loadTheme, themeErrors, defaultTheme } from '../src/tui/screen.ts';

describe('loadTheme', () => {
	test('keeps valid overrides of every color form', () => {
		const theme = loadTheme({ theme: {
			fg: null,
			inputBg: { type: 'hex', value: '#39274C' },
			system: { type: '256', n: 200 },
			barFg: { type: 'ansi16', n: 12 },
		} });
		expect(theme.fg).toBeNull();
		expect(theme.inputBg).toEqual({ type: 'hex', value: '#39274C' });
		expect(theme.system).toEqual({ type: '256', n: 200 });
		expect(theme.barFg).toEqual({ type: 'ansi16', n: 12 });
	});

	test('drops each invalid kind back to its default', () => {
		const theme = loadTheme({ theme: {
			inputBg: { type: 'hex', value: '##00ff00' },
			barFg: { type: 'ansi16', n: 99 },
			system: { type: '256', n: 999 },
			modalBorder: { type: 'rgb', r: 1 } as never,
			calloutBg: 'red' as never,
		} });
		expect(theme.inputBg).toEqual(defaultTheme.inputBg);
		expect(theme.barFg).toEqual(defaultTheme.barFg);
		expect(theme.system).toEqual(defaultTheme.system);
		expect(theme.modalBorder).toEqual(defaultTheme.modalBorder);
		expect(theme.calloutBg).toEqual(defaultTheme.calloutBg);
	});

	test('ignores unknown and comment keys', () => {
		const theme = loadTheme({ theme: {
			_inputBg: 'text input background',
			bogusKey: { type: 'hex', value: '#ffffff' },
		} as never });
		expect(theme).toEqual(defaultTheme);
	});

	test('no theme section yields the defaults', () => {
		expect(loadTheme({})).toEqual(defaultTheme);
	});
});

describe('themeErrors', () => {
	test('lists only the invalid known keys, in default order', () => {
		expect(themeErrors({ theme: {
			barFg: { type: 'ansi16', n: 7 },          // valid, not reported
			inputBg: { type: 'hex', value: '##00ff00' }, // invalid
			system: { type: '256', n: 999 },            // invalid
			_inputBg: 'comment',                         // unknown, ignored
		} as never })).toEqual(['inputBg', 'system']);
	});

	test('empty when every override is valid', () => {
		expect(themeErrors({ theme: { fg: null, barFg: { type: 'ansi16', n: 1 } } })).toEqual([]);
	});

	test('empty when there is no theme section', () => {
		expect(themeErrors({})).toEqual([]);
	});
});
