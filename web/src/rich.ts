import { el } from './util.js';
import { stripFormatChars } from '@covcom/lib';
import type { Span, Doc } from '@covcom/lib';

// Safe rich-text model for system messages, event-log summaries, and (via the
// shared markup parser) user messages. Producers emit tokens; the renderers
// below build DOM via textContent/createElement, so a user-controlled value can
// never become markup. There is no HTML-string path; no innerHTML anywhere.
//
// Every token's text is passed through stripFormatChars() so bidi controls and
// zero-width chars can't reorder/spoof the rendered text. (CSS unicode-bidi:
// isolate on the message/name spans is the layout-level half of the same fix.)

export type { Span, Block, Doc, RichText } from '@covcom/lib';
export { b, code } from '@covcom/lib';

function renderSpan(target: HTMLElement, s: Span): void {
	if (typeof s === 'string') {
		target.appendChild(document.createTextNode(stripFormatChars(s)));
	} else if ('b' in s) {
		target.appendChild(el('b', undefined, stripFormatChars(s.b)));
	} else if ('i' in s) {
		target.appendChild(el('i', undefined, stripFormatChars(s.i)));
	} else if ('bi' in s) {
		const bold = el('b');
		bold.appendChild(el('i', undefined, stripFormatChars(s.bi)));
		target.appendChild(bold);
	} else {
		target.appendChild(el('kbd', undefined, stripFormatChars(s.code)));
	}
}

// Inline-only rendering for system messages and event-log summaries.
export function renderRich(target: HTMLElement, rich: string | Span[]): void {
	target.replaceChildren();
	const spans = typeof rich === 'string' ? [rich] : rich;
	for (const s of spans) renderSpan(target, s);
}

// Block-level rendering for parsed user messages. `pre` → a <pre> (textContent
// preserves whitespace, scrolls instead of reflowing). `p` → inline spans on
// the container (which is white-space: pre-wrap), with a newline text node
// between consecutive paragraphs to keep the original line breaks.
export function renderDoc(target: HTMLElement, doc: Doc): void {
	target.replaceChildren();
	for (let idx = 0; idx < doc.length; idx++) {
		const block = doc[idx];
		if ('pre' in block) {
			target.appendChild(el('pre', 'msg-pre', stripFormatChars(block.pre)));
			continue;
		}
		const prev = doc[idx - 1];
		if (idx > 0 && prev && !('pre' in prev)) target.appendChild(document.createTextNode('\n'));
		for (const s of block.p) renderSpan(target, s);
	}
}
