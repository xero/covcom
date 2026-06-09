import {
	armorInvite,
	inviteFilename,
	INVITE_VERSION,
	CRYPTO_TABLE,
	serializeInvite,
} from '@covcom/lib';
import type { CovcomSession } from '../session.js';
import type { Screen } from '../store.js';
import { dispatch } from '../store.js';
import { el, clear } from '../util.js';
import { qrToSvg } from '../qr.js';

function b64enc(bytes: Uint8Array): string {
	let s = '';
	const CHUNK = 8192;
	for (let i = 0; i < bytes.length; i += CHUNK)
		s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
	return btoa(s);
}

function makeArmoredInvite(roomId: string, secret: Uint8Array, dns?: string): string {
	return armorInvite(serializeInvite({
		version: INVITE_VERSION,
		roomId,
		roomSecret: b64enc(secret),
		dns,
	}));
}

export function mountWaiting(
	app:     Element,
	session: CovcomSession,
	screen:  Screen & { name: 'waiting' },
): () => void {
	clear(app);
	const { room } = screen;
	const armoredInvite = makeArmoredInvite(room.id, room.secret, room.dns);

	const view   = el('section', 'view-waiting');
	const status = el('p', 'status-line', 'waiting for peer to join…');
	const pre    = el('pre', 'invite-block', armoredInvite);

	const btnCopy = el('button', undefined, 'Copy');
	btnCopy.addEventListener('click', () => {
		navigator.clipboard.writeText(armoredInvite).then(() => {
			btnCopy.textContent = 'Copied!';
			setTimeout(() => {
				btnCopy.textContent = 'Copy';
			}, 1500);
		}).catch(() => {
			btnCopy.textContent = 'Copy failed - select manually';
			setTimeout(() => {
				btnCopy.textContent = 'Copy';
			}, 2000);
		});
	});

	const btnDl = el('button', 'btn-secondary', 'Download');
	btnDl.addEventListener('click', () => {
		const blob = new Blob([armoredInvite], { type: 'text/plain' });
		const url  = URL.createObjectURL(blob);
		const a    = document.createElement('a');
		a.href     = url;
		a.download = inviteFilename(room.id);
		a.click();
		URL.revokeObjectURL(url);
	});

	// Abandons the freshly created room: tear the connection down and return to
	// landing with the username carried forward, mirroring the fatal path in
	// bridge.ts. dispose() nulls the ws handlers before closing, so no stray
	// reconnect or fatal event fires.
	const btnCancel = el('button', 'btn-secondary', 'Cancel');
	btnCancel.addEventListener('click', () => {
		session.dispose();
		dispatch({ type: 'RESET' });
		dispatch({ type: 'GOTO_LANDING', prefill: { username: screen.username } });
	});

	const btnRow = el('div', 'btn-row');
	btnRow.append(btnCopy, btnDl, btnCancel);

	let qr: SVGSVGElement | null = null;
	try {
		qr = qrToSvg(armoredInvite);
		qr.classList.add('invite-qr');
		qr.id = 'invite-qr';
	} catch { /* invite too large to encode: omit the QR */ }

	// Rows come from lib's CRYPTO_TABLE so they can't drift from the cli. The
	// COMPONENT/PRIMITIVE header is the dl's first row, styled apart from the
	// facts beneath it.
	const dl = el('dl', 'crypto-summary');
	dl.appendChild(el('dt', 'crypto-head', 'COMPONENT'));
	dl.appendChild(el('dd', 'crypto-head', 'PRIMITIVE'));
	for (const [term, def] of CRYPTO_TABLE) {
		dl.appendChild(el('dt', undefined, term));
		dl.appendChild(el('dd', undefined, def));
	}

	view.append(status, pre, btnRow, ...(qr ? [qr] : []), dl);
	app.appendChild(view);

	return (): void => {
		clear(app);
	};
}
