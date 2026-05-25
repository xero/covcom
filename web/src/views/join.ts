import { parseArmoredInvite } from '@covcom/lib';
import type { InvitePayload } from '@covcom/lib';
import { el } from '../util.js';

export interface JoinFormOpts {
	username:  string;
	onConnect: (invite: InvitePayload) => void;
	onBack:    () => void;
}

// Returns the rooted form element; caller (landing) decides when to swap it in.
// No store subscription — parse errors are local UI state.
export function buildJoinForm(opts: JoinFormOpts): HTMLElement {
	const view = el('section', 'view-join');

	const fileHidden = document.createElement('input');
	fileHidden.type   = 'file';
	fileHidden.accept = '.room,text/plain';
	fileHidden.style.display = 'none';

	const dropZone   = el('div', 'drop-zone');
	const dropText   = document.createElement('span');
	dropText.textContent = 'drop .room file here, or ';
	const browseLink = el('a', undefined, 'Browse');
	browseLink.href  = '#';
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

	const pasteLabel = el('p', 'paste-label', 'or paste invite text:');
	const textarea   = document.createElement('textarea');
	textarea.rows        = 5;
	textarea.placeholder = '-----BEGIN COVCOM INVITE-----…';
	const btnParse = el('button', 'btn-secondary', 'Parse');

	const errorEl = el('p', 'error');
	errorEl.style.display = 'none';

	const summaryEl = el('div', 'invite-summary');
	summaryEl.style.display = 'none';
	const summaryText = el('p');
	const btnConnect  = el('button', undefined, 'Connect');
	summaryEl.append(summaryText, btnConnect);

	const btnBack = el('button', 'btn-secondary', 'Back');
	btnBack.addEventListener('click', opts.onBack);

	let parsedInvite: InvitePayload | null = null;

	function handleText(text: string): void {
		errorEl.style.display = 'none';
		try {
			parsedInvite = parseArmoredInvite(text);
			summaryText.textContent = `room: ${parsedInvite.roomId}${parsedInvite.dns ? ` · server: ${parsedInvite.dns}` : ''}`;
			summaryEl.style.display = '';
		} catch (err) {
			errorEl.textContent     = `Parse error: ${err instanceof Error ? err.message : String(err)}`;
			errorEl.style.display   = '';
			summaryEl.style.display = 'none';
			parsedInvite = null;
		}
	}

	function readFileAsText(file: File): void {
		const reader  = new FileReader();
		reader.onload = (): void => {
			handleText(reader.result as string);
		};
		reader.readAsText(file);
	}

	btnParse.addEventListener('click', () => handleText(textarea.value));
	btnConnect.addEventListener('click', () => {
		if (parsedInvite) opts.onConnect(parsedInvite);
	});

	view.append(dropZone, pasteLabel, textarea, btnParse, errorEl, summaryEl, btnBack);
	return view;
}
