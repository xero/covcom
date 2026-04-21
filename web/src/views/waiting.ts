import QRCode from 'qrcode';
import { inviteFilename } from '@covcom/lib';
import { el, clear } from '../util.js';

interface WaitingOpts {
	armoredInvite: string
	roomId: string
	username: string
}

export function renderWaiting(root: Element, opts: WaitingOpts): void {
	clear(root);
	const { armoredInvite, roomId } = opts;

	const view = el('section', 'view-waiting');

	const status = el('p', 'status-line', 'waiting for peer to join\u2026');

	const pre = el('pre', 'invite-block', armoredInvite);

	// Copy + download buttons
	const btnCopy = el('button', undefined, 'Copy');
	btnCopy.addEventListener('click', () => {
		navigator.clipboard.writeText(armoredInvite).then(() => {
			btnCopy.textContent = 'Copied!';
			setTimeout(() => {
				btnCopy.textContent = 'Copy';
			}, 1500);
		}).catch(() => { /* ignore */ });
	});

	const btnDl = el('button', 'btn-secondary', 'Download');
	btnDl.addEventListener('click', () => {
		const blob = new Blob([armoredInvite], { type: 'text/plain' });
		const url  = URL.createObjectURL(blob);
		const a    = document.createElement('a');
		a.href     = url;
		a.download = inviteFilename(roomId);
		a.click();
		URL.revokeObjectURL(url);
	});

	const btnRow = el('div', 'btn-row');
	btnRow.append(btnCopy, btnDl);

	// QR code
	const canvas = document.createElement('canvas');
	canvas.className = 'invite-qr';
	canvas.id = 'invite-qr';
	void QRCode.toCanvas(canvas, armoredInvite, { errorCorrectionLevel: 'L', margin: 1 })
		.catch(() => {
			canvas.style.display = 'none';
		});

	// Crypto summary
	const dl = el('dl', 'crypto-summary');
	const entries: [string, string][] = [
		['cipher', 'XChaCha20-Poly1305'],
		['KEM',    'ML-KEM-768'],
		['format', '0x01'],
	];
	for (const [term, def] of entries) {
		dl.appendChild(el('dt', undefined, term));
		dl.appendChild(el('dd', undefined, def));
	}

	view.append(status, pre, btnRow, canvas, dl);
	root.appendChild(view);
}
