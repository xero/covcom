import type { CovcomSession } from '../session.js';
import type { Screen } from '../store.js';
import { el, clear } from '../util.js';
import { buildJoinForm } from './join.js';

interface MainFormOpts {
	session:    CovcomSession;
	error?:     string;
	prefillUsername?: string;
	onJoinClick: (username: string) => void;
}

// The two sub-trees live in separate builders so the back-from-join swap doesn't
// have to reconcile against a single root.
function buildMainForm(opts: MainFormOpts): HTMLElement {
	const view = el('section', 'view-landing');

	const serverField = el('div', 'field');
	const serverLabel = el('label', undefined, 'Server');
	serverLabel.htmlFor = 'server';
	const serverInput = el('input');
	serverInput.type = 'text';
	serverInput.id   = 'server';
	serverInput.placeholder = 'example.com or localhost:3000';
	serverField.append(serverLabel, serverInput);

	const usernameField = el('div', 'field');
	const usernameLabel = el('label', undefined, 'Username');
	usernameLabel.htmlFor = 'username';
	const usernameInput   = el('input');
	usernameInput.type = 'text';
	usernameInput.id   = 'username';
	usernameInput.placeholder = 'handle';
	usernameInput.maxLength = 64;  // matches the server-side cap in relay.ts
	if (opts.prefillUsername) usernameInput.value = opts.prefillUsername;
	usernameField.append(usernameLabel, usernameInput);

	const advancedToggle = el('a', 'advanced-toggle', 'Advanced');
	advancedToggle.href = '#';

	const tokenField = el('div', 'field');
	tokenField.style.display = 'none';
	const tokenLabel = el('label', undefined, 'Server Password');
	tokenLabel.htmlFor = 'token';
	const tokenInput = el('input');
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
	if (opts.error) {
		errorEl.textContent     = opts.error;
		errorEl.style.display   = 'inline';
	} else {
		errorEl.style.display = 'none';
	}

	function showError(msg: string): void {
		errorEl.textContent   = msg;
		errorEl.style.display = 'inline';
	}

	const btnRow    = el('div', 'btn-row');
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
		void opts.session.create({
			server,
			username,
			adminToken: tokenInput.value.trim() || undefined,
		});
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
	return view;
}

export function mountLanding(
	app:     Element,
	session: CovcomSession,
	screen:  Screen & { name: 'landing' },
): () => void {
	clear(app);

	let current: HTMLElement;

	const showMain = (prefillUsername?: string): void => {
		const next = buildMainForm({
			session,
			error: screen.error,
			prefillUsername: prefillUsername ?? screen.prefill?.username,
			onJoinClick: (u) => showJoin(u),
		});
		current.replaceWith(next);
		current = next;
	};

	const showJoin = (username: string): void => {
		const next = buildJoinForm({
			username,
			onConnect: (invite) => {
				void session.join(invite, username);
			},
			onBack: () => showMain(username),
		});
		current.replaceWith(next);
		current = next;
	};

	current = buildMainForm({
		session,
		error: screen.error,
		prefillUsername: screen.prefill?.username,
		onJoinClick: (u) => showJoin(u),
	});
	app.appendChild(current);

	return (): void => {
		clear(app);
	};
}
