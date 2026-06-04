import { describe, expect, test } from 'bun:test';
import { parseMarkup, b, i, bi, code } from '../src/markup.js';
import type { Doc } from '../src/markup.js';

// Single-line helper: most cases are one paragraph, so unwrap to its spans.
function spans(src: string) {
	const doc = parseMarkup(src);
	expect(doc.length).toBe(1);
	const block = doc[0];
	if (!('p' in block)) throw new Error('expected a paragraph block');
	return block.p;
}

describe('parseMarkup: emphasis', () => {
	test('bold', () => {
		expect(spans('*hi*')).toEqual([b('hi')]);
	});
	test('italic', () => {
		expect(spans('_hi_')).toEqual([i('hi')]);
	});
	test('bold+italic via _*…*_', () => {
		expect(spans('_*hi*_')).toEqual([bi('hi')]);
	});
	test('bold+italic via *_…_*', () => {
		expect(spans('*_hi_*')).toEqual([bi('hi')]);
	});
	test('inline code', () => {
		expect(spans('`x`')).toEqual([code('x')]);
	});
	test('emphasis surrounded by text', () => {
		expect(spans('a *b* c')).toEqual(['a ', b('b'), ' c']);
	});
});

describe('parseMarkup: rules', () => {
	test('single depth: **bold** → *<b>bold</b>*', () => {
		expect(spans('**bold**')).toEqual(['*', b('bold'), '*']);
	});
	test('surplus markers on one side stay literal', () => {
		expect(spans('__it_')).toEqual(['_', i('it')]);
	});
	test('code wins: no emphasis parsed inside inline code', () => {
		expect(spans('`*x*`')).toEqual([code('*x*')]);
	});
	test('empty emphasis renders as literal markers, never an empty token', () => {
		expect(spans('**')).toEqual(['**']);
	});
	test('empty code renders as literal backticks', () => {
		expect(spans('``')).toEqual(['``']);
	});
	test('unbalanced opener is literal', () => {
		expect(spans('*hi')).toEqual(['*hi']);
	});
	test('unbalanced closer is literal', () => {
		expect(spans('hi*')).toEqual(['hi*']);
	});
	test('unterminated inline code is literal', () => {
		expect(spans('a `b')).toEqual(['a `b']);
	});
});

describe('parseMarkup: blocks', () => {
	test('fenced block preserves internal whitespace', () => {
		expect(parseMarkup('```\n  a   b\n```')).toEqual([{ pre: '  a   b' }] as Doc);
	});
	test('fenced block preserves newlines', () => {
		expect(parseMarkup('```\nl1\nl2\n```')).toEqual([{ pre: 'l1\nl2' }] as Doc);
	});
	test('fence with info string still opens a block', () => {
		expect(parseMarkup('```ts\nx\n```')).toEqual([{ pre: 'x' }] as Doc);
	});
	test('text around a fence becomes paragraphs', () => {
		expect(parseMarkup('a\n```\ncode\n```\nb')).toEqual([
			{ p: ['a'] },
			{ pre: 'code' },
			{ p: ['b'] },
		] as Doc);
	});
	test('no emphasis is parsed inside a fenced block', () => {
		expect(parseMarkup('```\n*not bold*\n```')).toEqual([{ pre: '*not bold*' }] as Doc);
	});
	test('unterminated fence does not swallow the rest of the message', () => {
		const doc = parseMarkup('```\nhi');
		expect(doc.length).toBe(2);
		expect(doc[1]).toEqual({ p: ['hi'] });
	});
	test('each newline is its own paragraph', () => {
		expect(parseMarkup('a\nb')).toEqual([{ p: ['a'] }, { p: ['b'] }] as Doc);
	});
	test('a blank line is an empty paragraph', () => {
		expect(parseMarkup('')).toEqual([{ p: [] }] as Doc);
	});
});

describe('parseMarkup: untrusted content stays literal in tokens', () => {
	test('html-ish payload inside bold is verbatim token text', () => {
		expect(spans('*<img src=x onerror=alert(1)>*')).toEqual([b('<img src=x onerror=alert(1)>')]);
	});
});

describe('parseMarkup: ReDoS / pathological inputs complete linearly', () => {
	test('10k identical markers', () => {
		const src = '*'.repeat(10_000);
		const doc = parseMarkup(src);
		expect(doc).toEqual([{ p: [src] }] as Doc);
	});
	test('10k alternating markers', () => {
		const src = '*_'.repeat(5_000);
		const doc = parseMarkup(src);
		// We only assert it terminates and yields a single paragraph; the exact
		// token split is an implementation detail of the surplus rule.
		expect(doc.length).toBe(1);
		expect('p' in doc[0]).toBe(true);
	});
	test('10k backticks', () => {
		const src = '`'.repeat(10_000);
		expect(() => parseMarkup(src)).not.toThrow();
	});
	test('deeply nested-looking emphasis terminates', () => {
		const src = '*'.repeat(5_000) + 'x' + '*'.repeat(5_000);
		expect(() => parseMarkup(src)).not.toThrow();
	});
	test('span count is capped on adversarial marker soup', () => {
		const src = 'a*b*'.repeat(10_000);
		const block = parseMarkup(src)[0];
		if (!('p' in block)) throw new Error('expected paragraph');
		// Uncapped this input would yield ~20k spans; the cap holds it near 4096.
		expect(block.p.length).toBeLessThan(5000);
	});
	test('the span cap is an exact ceiling, not off-by-one', () => {
		const src = 'a*b*'.repeat(10_000);
		const block = parseMarkup(src)[0];
		if (!('p' in block)) throw new Error('expected paragraph');
		// The trailing flush must not push the total past MAX_SPANS_PER_LINE (4096).
		expect(block.p.length).toBeLessThanOrEqual(4096);
	});
});
