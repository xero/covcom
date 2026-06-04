// Safe markdown-subset token model, shared by both clients. DOM-free and
// crypto-free: this module turns untrusted message text into a token tree. Each
// client owns its own renderer (DOM for web, ANSI for CLI). No HTML strings are
// ever built here, so there is no XSS sink and no mXSS surface.
//
// The parser is a hand-written linear scanner, NOT a backtracking regex, so it
// is immune to ReDoS. See parseMarkup below.

export type Span =
	| string             // plain text
	| { b: string }      // bold
	| { i: string }      // italic
	| { bi: string }     // bold + italic
	| { code: string };  // inline code

export type Block =
	| { p: Span[] }      // a line of inline spans
	| { pre: string };   // fenced block; raw, preserves whitespace/newlines

export type Doc = Block[];

// Inline-only rich text. System messages and event-log summaries use this; their
// producers (b/code) live here so a single token vocabulary serves both the
// formatter and the summary layer.
export type RichText = string | Span[];

export const b    = (s: string): Span => ({ b: s });
export const i    = (s: string): Span => ({ i: s });
export const bi   = (s: string): Span => ({ bi: s });
export const code = (s: string): Span => ({ code: s });

// Defensive cap on spans per line. A line that produces more than this many
// spans almost certainly is an adversarial marker-soup payload; once hit, the
// remainder of the line is emitted as a single literal text span. The scanner is
// already O(n), so this is belt-and-suspenders, not the primary defense.
const MAX_SPANS_PER_LINE = 4096;

function isFence(line: string): boolean {
	return /^\s*```/.test(line);
}

// Block pass: split on newlines, group lines between ``` fences into a raw pre
// block (whitespace preserved), and turn every other line into one paragraph of
// inline spans. A fence with no matching close is not treated as a block; its
// opener line falls through to normal inline parsing, so a stray ``` never
// swallows the rest of the message.
export function parseMarkup(src: string): Doc {
	const lines = src.split('\n');
	const doc: Doc = [];
	let i = 0;
	while (i < lines.length) {
		if (isFence(lines[i])) {
			let close = -1;
			for (let j = i + 1; j < lines.length; j++) {
				if (isFence(lines[j])) {
					close = j; break;
				}
			}
			if (close !== -1) {
				doc.push({ pre: lines.slice(i + 1, close).join('\n') });
				i = close + 1;
				continue;
			}
			// unterminated fence: fall through and parse the opener as a line
		}
		doc.push({ p: parseInline(lines[i]) });
		i++;
	}
	return doc;
}

// Inline pass: a single left-to-right scan with depth-1 state. Code is tried
// first (its contents are literal, "code wins"), then the two-char combined
// markers _* / *_ (bold+italic), then single * (bold) / _ (italic). Emphasis
// content is literal text: there is no nesting (single depth), so a closer is
// just the next matching marker.
function parseInline(src: string): Span[] {
	const spans: Span[] = [];
	const n = src.length;
	let buf = '';
	let i = 0;

	const flush = (): void => {
		if (buf) {
			spans.push(buf); buf = '';
		}
	};

	while (i < n) {
		// Stop before the cap with room for the two spans a single emphasis step can
		// push (flushed buffer + token) plus the one literal remainder flushed after
		// the loop, so the final count never exceeds MAX_SPANS_PER_LINE.
		if (spans.length >= MAX_SPANS_PER_LINE - 2) {
			buf += src.slice(i);
			break;
		}
		const c = src[i];

		// inline code: `…` (single backtick delimiter, contents literal)
		if (c === '`') {
			const close = src.indexOf('`', i + 1);
			if (close === -1) {
				buf += '`'; i++; continue;
			}
			const content = src.slice(i + 1, close);
			if (content.length === 0) {
				// empty span `` → literal backticks, never an empty token
				buf += '``'; i = close + 1; continue;
			}
			flush(); spans.push({ code: content }); i = close + 1; continue;
		}

		// combined bold+italic: _* … *_  or  *_ … _*  (closer is the reversed pair)
		if ((c === '_' && src[i + 1] === '*') || (c === '*' && src[i + 1] === '_')) {
			const closer = src[i + 1] + c;
			const close  = src.indexOf(closer, i + 2);
			if (close > i + 2) {
				flush(); spans.push({ bi: src.slice(i + 2, close) }); i = close + 2; continue;
			}
			// no valid combined closer → fall through to single-marker handling
		}

		// single-marker emphasis: * (bold) or _ (italic)
		if (c === '*' || c === '_') {
			// surplus rule: a run of k identical markers contributes one delimiter;
			// the other k−1 render as literal text on the opener side.
			let run = 1;
			while (src[i + run] === c) run++;
			const close = src.indexOf(c, i + run);
			if (close === -1) {
				// unbalanced: the whole run is literal
				buf += c.repeat(run); i += run; continue;
			}
			buf += c.repeat(run - 1);              // surplus opener markers
			flush();
			const content = src.slice(i + run, close);
			spans.push(c === '*' ? { b: content } : { i: content });
			// closer surplus: a run of m markers closes with one delimiter, the
			// other m−1 render as literal text after the span.
			let crun = 1;
			while (src[close + crun] === c) crun++;
			buf += c.repeat(crun - 1);
			i = close + crun;
			continue;
		}

		buf += c; i++;
	}
	flush();
	return spans;
}
