import { el, clear } from '../util.js';

interface LandingOpts {
	onCreate:    (server: string, username: string, adminToken?: string) => void
	onJoinClick: (username: string) => void
}

export function renderLanding(root: Element, opts: LandingOpts): void {
	clear(root);
	const view = el('section', 'view-landing');

	// Server DNS
	const serverField = el('div', 'field');
	const serverLabel = el('label', undefined, 'server');
	serverLabel.htmlFor = 'server';
	const serverInput = el('input') as HTMLInputElement;
	serverInput.type = 'text';
	serverInput.id = 'server';
	serverInput.placeholder = 'example.com or localhost:3000';
	serverField.append(serverLabel, serverInput);

	// Username
	const usernameField = el('div', 'field');
	const usernameLabel = el('label', undefined, 'username');
	usernameLabel.htmlFor = 'username';
	const usernameInput = el('input') as HTMLInputElement;
	usernameInput.type = 'text';
	usernameInput.id = 'username';
	usernameInput.placeholder = 'your name';
	usernameField.append(usernameLabel, usernameInput);

	// Server password (hidden by default)
	const advancedToggle = el('a', 'advanced-toggle', 'advanced');
	advancedToggle.href = '#';

	const tokenField = el('div', 'field');
	tokenField.style.display = 'none';
	const tokenLabel = el('label', undefined, 'server password');
	tokenLabel.htmlFor = 'token';
	const tokenInput = el('input') as HTMLInputElement;
	tokenInput.type = 'password';
	tokenInput.autocomplete = 'off';
	tokenInput.id = 'token';
	tokenInput.placeholder = 'optional';
	tokenField.append(tokenLabel, tokenInput);

	advancedToggle.addEventListener('click', (e) => {
		e.preventDefault();
		tokenField.style.display = tokenField.style.display === 'none' ? '' : 'none';
	});

	const errorEl = el('p', 'error');
	errorEl.style.display = 'none';

	function showError(msg: string): void {
		errorEl.textContent = msg;
		errorEl.style.display = '';
	}

	const btnRow = el('div', 'btn-row');
	const btnCreate = el('button', undefined, 'Create Room');
	const btnJoin   = el('button', 'btn-secondary', 'Join Room');

	btnCreate.addEventListener('click', () => {
		const server   = serverInput.value.trim();
		const username = usernameInput.value.trim();
		if (!server || !username) {
			showError('Server and username are required');
			return;
		}
		errorEl.style.display = 'none';
		opts.onCreate(server, username, tokenInput.value.trim() || undefined);
	});

	btnJoin.addEventListener('click', () => {
		const username = usernameInput.value.trim();
		if (!username) {
			showError('Username is required');
			return;
		}
		errorEl.style.display = 'none';
		opts.onJoinClick(username);
	});

	btnRow.append(btnCreate, btnJoin);
	view.append(serverField, usernameField, advancedToggle, tokenField, errorEl, btnRow);
	root.appendChild(view);
}
