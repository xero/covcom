import { test, expect, describe } from 'bun:test';
import { parseMarkup } from '@covcom/lib';
import { renderDoc } from '../src/rich.js';

// The web message path is parseMarkup → renderDoc. These tests are the XSS
// allowlist oracle: render attacker payloads and assert the resulting DOM
// contains ONLY the four formatting tags, with no script and no dangerous
// attributes. No DOMPurify; safety is by construction (textContent only).

const ALLOWED_TAGS = new Set(['B', 'I', 'KBD', 'PRE']);
const FORBIDDEN_ATTRS = ['onerror', 'onclick', 'onload', 'href', 'src', 'style'];

function render(src: string): HTMLElement {
	const host = document.createElement('span');
	renderDoc(host, parseMarkup(src));
	return host;
}

function assertSafe(host: HTMLElement): void {
	expect(host.querySelector('script')).toBeNull();
	for (const node of Array.from(host.querySelectorAll('*'))) {
		expect(ALLOWED_TAGS.has(node.tagName)).toBe(true);
		for (const attr of FORBIDDEN_ATTRS) expect(node.hasAttribute(attr)).toBe(false);
		// element wrappers carry no attributes at all beyond the static class on <pre>
		for (const a of Array.from(node.attributes)) {
			expect(a.name === 'class' && node.tagName === 'PRE').toBe(true);
		}
	}
}

describe('renderDoc: XSS allowlist oracle', () => {
	test('a script payload renders as inert text', () => {
		const host = render('<script>alert(1)</' + 'script>');
		assertSafe(host);
		expect(host.textContent).toBe('<script>alert(1)</script>');
	});

	test('an img-onerror payload inside bold is text, not an element', () => {
		const host = render('*<img src=x onerror=alert(1)>*');
		assertSafe(host);
		const bold = host.querySelector('b');
		expect(bold).not.toBeNull();
		expect(bold!.textContent).toBe('<img src=x onerror=alert(1)>');
		expect(host.querySelector('img')).toBeNull();
	});

	test('a payload inside a fenced block is inert pre text', () => {
		const host = render('```\n<script>x</' + 'script>\n```');
		assertSafe(host);
		const pre = host.querySelector('pre');
		expect(pre).not.toBeNull();
		expect(pre!.textContent).toBe('<script>x</script>');
	});

	test('all four token kinds map to exactly b/i/kbd/pre', () => {
		const host = render('*b* _i_ _*bi*_ `c`\n```\nblock\n```');
		assertSafe(host);
		expect(host.querySelector('b')).not.toBeNull();
		expect(host.querySelector('i')).not.toBeNull();
		expect(host.querySelector('kbd')).not.toBeNull();
		expect(host.querySelector('pre')).not.toBeNull();
		// bi nests <i> inside <b>
		expect(host.querySelector('b > i')).not.toBeNull();
	});

	test('multi-line message keeps a line break between paragraphs', () => {
		const host = render('line one\nline two');
		assertSafe(host);
		expect(host.textContent).toBe('line one\nline two');
	});

	test('bidi/zero-width format chars are stripped from rendered text', () => {
		const rlo = String.fromCodePoint(0x202e), zwsp = String.fromCodePoint(0x200b);
		const host = render(`ev${rlo}il${zwsp}x`);
		assertSafe(host);
		expect(host.textContent).toBe('evilx');
	});

	test('format chars are stripped inside a fenced block too', () => {
		const rlo  = String.fromCodePoint(0x202e);
		const host = render('```\na' + rlo + 'b\n```');
		expect(host.querySelector('pre')!.textContent).toBe('ab');
	});

	test('ZWJ survives rendering (legit emoji sequences)', () => {
		const zwj  = String.fromCodePoint(0x200d);
		const host = render(`a${zwj}b`);
		expect(host.textContent).toBe(`a${zwj}b`);
	});
});
