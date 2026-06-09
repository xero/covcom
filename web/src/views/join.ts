import { parseArmoredInvite } from '@covcom/lib';
import type { InvitePayload } from '@covcom/lib';
import { el } from '../util.js';

export interface JoinFormOpts {
	username:    string;
	inviteText?: string;
	error?:      string;
	onConnect:   (invite: InvitePayload, text: string, username: string) => void;
	onBack:      (username: string) => void;
}

// Returns the rooted form element; caller (landing) decides when to swap it in.
// No store subscription; parse errors are local UI state. There is no separate
// parse step: Join Room parses and either errors inline or connects.
export function buildJoinForm(opts: JoinFormOpts): HTMLElement {
	const view = el('section', 'view-join');

	const usernameField = el('div', 'field');
	const usernameLabel = el('label', undefined, 'Username');
	usernameLabel.htmlFor = 'username';
	const usernameInput   = el('input');
	usernameInput.type = 'text';
	usernameInput.id   = 'username';
	usernameInput.placeholder = 'handle';
	usernameInput.maxLength = 64;
	usernameInput.value = opts.username;
	usernameField.append(usernameLabel, usernameInput);

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
		if (file) readFileIntoTextarea(file);
	});
	fileHidden.addEventListener('change', () => {
		const file = fileHidden.files?.[0];
		if (file) readFileIntoTextarea(file);
	});

	const pasteLabel = el('p', 'paste-label', 'or paste invite text:');
	const textarea   = document.createElement('textarea');
	textarea.rows        = 5;
	textarea.placeholder = '-----BEGIN COVCOM INVITE-----…';
	if (opts.inviteText) textarea.value = opts.inviteText;

	const errorEl = el('p', 'error');
	if (opts.error) {
		errorEl.textContent   = opts.error;
		errorEl.style.display = '';
	} else {
		errorEl.style.display = 'none';
	}
	function showError(msg: string): void {
		errorEl.textContent   = msg;
		errorEl.style.display = '';
	}

	// A dropped or browsed file populates the textarea, so the textarea is the
	// single source Join Room parses.
	function readFileIntoTextarea(file: File): void {
		const reader  = new FileReader();
		reader.onload = (): void => {
			textarea.value = reader.result as string;
		};
		reader.readAsText(file);
	}

	const btnRow  = el('div', 'btn-row');
	const btnJoin = el('button', undefined, 'Join Room');
	const btnBack = el('button', 'btn-secondary', 'Cancel');

	btnJoin.addEventListener('click', () => {
		const username = usernameInput.value.trim();
		if (!username) {
			showError('Username is required');
			return;
		}
		const text = textarea.value.trim();
		if (!text) {
			showError('Paste an invite or drop a .room file first');
			return;
		}
		let invite: InvitePayload;
		try {
			invite = parseArmoredInvite(text);
		} catch (err) {
			showError(`Parse error: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		errorEl.style.display = 'none';
		opts.onConnect(invite, text, username);
	});
	btnBack.addEventListener('click', () => opts.onBack(usernameInput.value.trim()));

	btnRow.append(btnJoin, btnBack);
	view.append(usernameField, dropZone, pasteLabel, textarea, errorEl, btnRow);
	return view;
}
