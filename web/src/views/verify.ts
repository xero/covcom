import type { FingerprintSurface } from '@covcom/lib';
import { el, clear } from '../util.js';
import { getState, subscribe } from '../store.js';
import { sidebarBody } from './sidebar.js';

function renderSwatchRow(parent: Element, fp: FingerprintSurface): void {
	const row = el('div', 'fp-swatches');
	for (const hex of fp.swatches) {
		const sw = el('span', 'fp-swatch');
		sw.style.backgroundColor = hex;
		sw.title = hex;
		row.appendChild(sw);
	}
	parent.appendChild(row);
	const hex = el('div', 'fp-hex', fp.hex);
	parent.appendChild(hex);
}

function render(body: Element, local: FingerprintSurface | undefined, peers: Map<string, { fingerprint: FingerprintSurface }>): void {
	clear(body);
	body.appendChild(el('h2', undefined, 'Verify session'));

	const intro = el('p', 'fp-intro');
	intro.textContent
		= 'Compare colors and hex out-of-band with the people you’re talking to. '
		+ 'A mismatch means the session is not what one of you thinks it is.';
	body.appendChild(intro);

	body.appendChild(el('h3', undefined, 'You'));
	if (local) renderSwatchRow(body, local);

	if (peers.size > 0) {
		body.appendChild(el('h3', undefined, 'Peers'));
		for (const [username, p] of peers) {
			body.appendChild(el('div', 'fp-peer-name', username));
			renderSwatchRow(body, p.fingerprint);
		}
	}
}

export function mountVerify(view: Element): () => void {
	const body = sidebarBody(view, 'verify');
	if (!body) return () => { /* sidebar not mounted */ };

	let lastLocalHex: string | null = null;
	let lastPeerHex  = new Map<string, string>();

	const off = subscribe(() => {
		const s        = getState();
		const localHex = s.localFingerprint?.hex ?? null;
		let changed    = localHex !== lastLocalHex || s.peers.size !== lastPeerHex.size;
		if (!changed) {
			for (const [name, view] of s.peers) {
				if (lastPeerHex.get(name) !== view.fingerprint.hex) {
					changed = true;
					break;
				}
			}
		}
		if (!changed) return;
		render(body, s.localFingerprint, s.peers);
		lastLocalHex = localHex;
		lastPeerHex  = new Map();
		for (const [name, view] of s.peers) lastPeerHex.set(name, view.fingerprint.hex);
	});

	return (): void => {
		off();
		clear(body);
	};
}
