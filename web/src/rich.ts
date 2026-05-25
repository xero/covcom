import { el } from './util.js';

// Safe rich-text model for system messages and event-log summaries. Producers
// emit tokens; renderRich builds DOM via textContent/createElement, so a
// user-controlled value can never become markup. The only intended markup is
// <b> (names) and <code> (room ids); there is no HTML-string path.

export type RichNode = string | { b: string } | { code: string };
export type RichText = string | RichNode[];

export const b    = (s: string): RichNode => ({ b: s });
export const code = (s: string): RichNode => ({ code: s });

export function renderRich(target: HTMLElement, rich: RichText): void {
	target.replaceChildren();
	const nodes = typeof rich === 'string' ? [rich] : rich;
	for (const n of nodes) {
		if (typeof n === 'string') target.appendChild(document.createTextNode(n));
		else if ('b' in n)         target.appendChild(el('b', undefined, n.b));
		else                       target.appendChild(el('code', undefined, n.code));
	}
}
