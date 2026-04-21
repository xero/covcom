import { parseArmoredInvite } from '@covcom/lib';
import type { InvitePayload } from '@covcom/lib';
import { el, clear } from '../util.js';

interface JoinOpts {
	username: string
	onConnect: (invite: InvitePayload) => void
}

export function renderJoin(root: Element, opts: JoinOpts): void {
	clear(root);
	const view = el('section', 'view-join');

	// Drop zone
	const fileHidden = document.createElement('input');
	fileHidden.type = 'file';
	fileHidden.accept = '.room,text/plain';
	fileHidden.style.display = 'none';

	const dropZone = el('div', 'drop-zone');
	const dropText = document.createElement('span');
	dropText.textContent = 'drop .room file here, or ';
	const browseLink = el('a', undefined, 'Browse');
	browseLink.href = '#';
	browseLink.addEventListener('click', (e) => {
		e.preventDefault();
		fileHidden.click();
	});
	dropZone.append(dropText, browseLink, fileHidden);

	dropZone.addEventListener('dragover', (e) => {
		e.preventDefault();
		dropZone.classList.add('dragover');
	});
	dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
	dropZone.addEventListener('drop', (e) => {
		e.preventDefault();
		dropZone.classList.remove('dragover');
		const file = e.dataTransfer?.files[0];
		if (file) readFileAsText(file);
	});
	fileHidden.addEventListener('change', () => {
		const file = fileHidden.files?.[0];
		if (file) readFileAsText(file);
	});

	// Paste area
	const pasteLabel = el('p', 'paste-label', 'or paste invite text:');
	const textarea = document.createElement('textarea');
	textarea.rows = 5;
	textarea.placeholder = '-----BEGIN COVCOM INVITE-----\u2026';
	const btnParse = el('button', 'btn-secondary', 'Parse');

	const errorEl = el('p', 'error');
	errorEl.style.display = 'none';

	// Invite summary (hidden until parsed)
	const summaryEl = el('div', 'invite-summary');
	summaryEl.style.display = 'none';
	const summaryText = el('p');
	const btnConnect = el('button', undefined, 'Connect');
	summaryEl.append(summaryText, btnConnect);

	let parsedInvite: InvitePayload | null = null;

	function handleText(text: string): void {
		errorEl.style.display = 'none';
		try {
			parsedInvite = parseArmoredInvite(text);
			summaryText.textContent = `room: ${parsedInvite.roomId}${parsedInvite.dns ? ` \u00b7 server: ${parsedInvite.dns}` : ''}`;
			summaryEl.style.display = '';
		} catch (err) {
			errorEl.textContent = `Parse error: ${err instanceof Error ? err.message : String(err)}`;
			errorEl.style.display = '';
			summaryEl.style.display = 'none';
			parsedInvite = null;
		}
	}

	function readFileAsText(file: File): void {
		const reader = new FileReader();
		reader.onload = () => handleText(reader.result as string);
		reader.readAsText(file);
	}

	btnParse.addEventListener('click', () => handleText(textarea.value));

	btnConnect.addEventListener('click', () => {
		if (parsedInvite) opts.onConnect(parsedInvite);
	});

	view.append(dropZone, pasteLabel, textarea, btnParse, errorEl, summaryEl);
	root.appendChild(view);
}
