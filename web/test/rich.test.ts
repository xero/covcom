import { test, expect, describe } from 'bun:test';
import { renderRich, b } from '../src/rich.js';
import { summarizeInbound } from '../src/wireSummary.js';

// These tests are the XSS regression guard: a malicious value carried through a
// token MUST land as inert text, never as live markup.

describe('renderRich', () => {
	test('a bold token containing an img-onerror payload renders as text, not an element', () => {
		const payload = '<img src=x onerror=alert(1)>';
		const div = document.createElement('div');
		renderRich(div, [b(payload), ' joined']);

		// No element was created from the payload.
		expect(div.querySelector('img')).toBeNull();
		// The payload is the verbatim text content of the <b>, not parsed HTML.
		const bold = div.querySelector('b');
		expect(bold).not.toBeNull();
		expect(bold!.textContent).toBe(payload);
		expect(div.textContent).toBe(`${payload} joined`);
	});

	test('a plain string with a <script> payload renders as text, not an element', () => {
		const payload = '<script>alert(1)</' + 'script>';
		const div = document.createElement('div');
		renderRich(div, payload);

		expect(div.querySelector('script')).toBeNull();
		expect(div.childElementCount).toBe(0);
		expect(div.textContent).toBe(payload);
	});

	test('replaceChildren clears prior content on re-render', () => {
		const div = document.createElement('div');
		renderRich(div, 'first');
		renderRich(div, 'second');
		expect(div.textContent).toBe('second');
	});
});

describe('wireSummary', () => {
	test('peer_joined summary is a token array carrying the verbatim username', () => {
		const username = '<b>x</b>';
		const { summary } = summarizeInbound({
			type: 'peer_joined',
			username,
			ek: 'AAAA',
			ratchetEk: 'BBBB',
			claim: 'CCCC',
		} as never);

		// Token array, not an HTML string, proving no string-concat path survives.
		expect(Array.isArray(summary)).toBe(true);
		const tokens = summary as (string | { b: string } | { code: string })[];
		const bold = tokens.find((t): t is { b: string } => typeof t === 'object' && 'b' in t);
		expect(bold?.b).toBe(username);

		// And it renders inert.
		const div = document.createElement('div');
		renderRich(div, summary);
		expect(div.querySelector('b')!.textContent).toBe(username);
		expect(div.textContent).toBe(`${username} joined`);
	});
});
