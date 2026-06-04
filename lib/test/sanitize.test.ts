import { describe, expect, test } from 'bun:test';
import { stripFormatChars, hasUnsafeFormatChars } from '../src/sanitize.js';

// Code points are spelled out (not literal invisibles) so this source stays
// reviewable. These are the display-hazard format chars: bidi controls (text
// reordering / Trojan-Source-style spoofing) and zero-width junk (homoglyphs).
const cp    = (n: number): string => String.fromCodePoint(n);
const RLO   = cp(0x202e);  // right-to-left override
const LRO   = cp(0x202d);  // left-to-right override
const LRI   = cp(0x2066);  // left-to-right isolate
const PDI   = cp(0x2069);  // pop directional isolate
const LRM   = cp(0x200e);  // left-to-right mark
const ZWSP  = cp(0x200b);  // zero-width space
const WJ    = cp(0x2060);  // word joiner
const BOM   = cp(0xfeff);  // zero-width no-break space
const ZWJ   = cp(0x200d);  // zero-width joiner (KEEP)
const ZWNJ  = cp(0x200c);  // zero-width non-joiner (KEEP)
const VS16  = cp(0xfe0f);  // emoji variation selector (KEEP)
const SMILE = cp(0x1f642); // 🙂 (astral, must survive)

describe('stripFormatChars', () => {
	test('removes bidi overrides, isolates, and marks', () => {
		expect(stripFormatChars(`ev${RLO}il`)).toBe('evil');
		expect(stripFormatChars(`${LRI}a${PDI}${LRO}b`)).toBe('ab');
		expect(stripFormatChars(`${LRM}x`)).toBe('x');
	});
	test('removes zero-width junk (ZWSP, word joiner, BOM)', () => {
		expect(stripFormatChars(`a${ZWSP}b${WJ}c${BOM}d`)).toBe('abcd');
	});
	test('KEEPS ZWJ/ZWNJ and variation selectors (legit emoji / Persian / Indic)', () => {
		expect(stripFormatChars(`man${ZWJ}woman`)).toBe(`man${ZWJ}woman`);
		expect(stripFormatChars(`x${ZWNJ}y`)).toBe(`x${ZWNJ}y`);
		expect(stripFormatChars(`heart${VS16}`)).toBe(`heart${VS16}`);
	});
	test('leaves ordinary text and astral chars untouched', () => {
		expect(stripFormatChars(`hello ${SMILE} world`)).toBe(`hello ${SMILE} world`);
	});
});

describe('hasUnsafeFormatChars', () => {
	test('true when a bidi control is present', () => {
		expect(hasUnsafeFormatChars(`a${RLO}b`)).toBe(true);
		expect(hasUnsafeFormatChars(`a${ZWSP}b`)).toBe(true);
	});
	test('false for clean text including ZWJ emoji', () => {
		expect(hasUnsafeFormatChars(`man${ZWJ}woman ${SMILE}`)).toBe(false);
	});
});
