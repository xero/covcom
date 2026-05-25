import QRCode from 'qrcode';
import {
	armorInvite,
	inviteFilename,
	INVITE_VERSION,
	serializeInvite,
} from '@covcom/lib';
import type { CovcomSession } from '../session.js';
import type { Screen } from '../store.js';
import { el, clear } from '../util.js';

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
	app:      Element,
	_session: CovcomSession,
	screen:   Screen & { name: 'waiting' },
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

	const btnRow = el('div', 'btn-row');
	btnRow.append(btnCopy, btnDl);

	const canvas = document.createElement('canvas');
	canvas.className = 'invite-qr';
	canvas.id        = 'invite-qr';
	void QRCode.toCanvas(canvas, armoredInvite, { errorCorrectionLevel: 'L', margin: 1 })
		.catch(() => {
			canvas.style.display = 'none';
		});

	// XChaCha20Cipher bumped to 0x03 in leviathan-crypto v3 (salamander defense).
	const dl = el('dl', 'crypto-summary');
	const entries: [string, string][] = [
		['cipher', 'XChaCha20-Poly1305'],
		['KEM',    'ML-KEM-768'],
		['format', '0x03'],
	];
	for (const [term, def] of entries) {
		dl.appendChild(el('dt', undefined, term));
		dl.appendChild(el('dd', undefined, def));
	}

	view.append(status, pre, btnRow, canvas, dl);
	app.appendChild(view);

	return (): void => {
		clear(app);
	};
}
