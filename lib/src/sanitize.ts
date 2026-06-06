// Unicode "format" characters that are display hazards rather than content:
// bidirectional controls (text reordering - Trojan-Source-style spoofing) and
// zero-width junk (homoglyph display names, invisible padding). They carry no
// legitimate meaning in a chat handle or message and are stripped from untrusted
// display text on both clients; the server rejects them in usernames (see
// server/src/relay.ts) to keep the name bound to its signed identity claim.
//
// Listed by code point (not literal chars) so this source stays pure ASCII and
// reviewable. Deliberately EXCLUDED - these are legitimate text, not spoofing
// controls, and stripping them would corrupt real multilingual text/emoji:
//   U+200C / U+200D  ZWNJ / ZWJ          (emoji sequences; Persian/Arabic/Indic joining)
//   U+FE00-U+FE0F    variation selectors (emoji vs text presentation)
const UNSAFE_FORMAT: ReadonlySet<number> = new Set([
	0x061c,                                     // Arabic letter mark
	0x200b,                                     // zero-width space
	0x200e, 0x200f,                             // LRM, RLM
	0x202a, 0x202b, 0x202c, 0x202d, 0x202e,     // LRE, RLE, PDF, LRO, RLO
	0x2060,                                     // word joiner
	0x2066, 0x2067, 0x2068, 0x2069,             // LRI, RLI, FSI, PDI (isolates)
	0xfeff,                                     // zero-width no-break space (BOM)
]);

// All targets are BMP, so charCodeAt(0) (always a number) equals the code point;
// an astral char's leading surrogate is never in the set, so it is kept intact.
export function stripFormatChars(s: string): string {
	const out: string[] = [];
	for (const ch of s) if (!UNSAFE_FORMAT.has(ch.charCodeAt(0))) out.push(ch);
	return out.join('');
}

// The detection companion to stripFormatChars, exported as part of the lib's
// public surface (lib/src/index.ts) so a caller can flag spoofed text rather
// than silently rewrite it - e.g. a UI affordance that warns on a suspicious
// display name. The app strips rather than detects today, so this is currently
// exercised only by tests; that is intentional, not dead code.
export function hasUnsafeFormatChars(s: string): boolean {
	for (const ch of s) if (UNSAFE_FORMAT.has(ch.charCodeAt(0))) return true;
	return false;
}
