import type { CovcomSession } from '../session.js';
import type { Screen } from '../store.js';
import { el, clear } from '../util.js';
import { buildJoinForm } from './join.js';

// The last submitted auth form, kept across the unmount the joining phase
// triggers so a fatal error drops the user back on the same sub-screen with
// their entries intact. Module-scoped so it survives the landing remount; the
// invite text and server stay out of the store this way.
interface PendingForm {
	mode:        'create' | 'join';
	username:    string;
	server?:     string;
	inviteText?: string;
}
let pendingForm: PendingForm | null = null;

interface MainFormOpts {
	username?: string;
	onCreate:  (username: string) => void;
	onJoin:    (username: string) => void;
}

// Landing: username only. Server lives on the create sub-screen (where it is
// needed); join reads the server baked into the invite.
function buildMainForm(opts: MainFormOpts): HTMLElement {
	const view = el('section', 'view-landing');

	const usernameField = el('div', 'field');
	const usernameLabel = el('label', undefined, 'Username');
	usernameLabel.htmlFor = 'username';
	const usernameInput   = el('input');
	usernameInput.type = 'text';
	usernameInput.id   = 'username';
	usernameInput.placeholder = 'handle';
	usernameInput.maxLength = 64;  // matches the server-side cap in relay.ts
	if (opts.username) usernameInput.value = opts.username;
	usernameField.append(usernameLabel, usernameInput);

	const errorEl = el('p', 'error');
	errorEl.style.display = 'none';
	function showError(msg: string): void {
		errorEl.textContent   = msg;
		errorEl.style.display = 'inline';
	}

	const btnRow    = el('div', 'btn-row');
	const btnCreate = el('button', undefined, 'Create Room');
	const btnJoin   = el('button', 'btn-secondary', 'Join Room');

	btnCreate.addEventListener('click', () => {
		const username = usernameInput.value.trim();
		if (!username) {
			showError('Username is required');
			return;
		}
		opts.onCreate(username);
	});
	btnJoin.addEventListener('click', () => {
		const username = usernameInput.value.trim();
		if (!username) {
			showError('Username is required');
			return;
		}
		opts.onJoin(username);
	});

	btnRow.append(btnCreate, btnJoin);
	view.append(usernameField, errorEl, btnRow);
	return view;
}

interface CreateFormOpts {
	session:   CovcomSession;
	username:  string;
	server?:   string;
	error?:    string;
	onCancel:  (username: string) => void;
}

function buildCreateForm(opts: CreateFormOpts): HTMLElement {
	const view = el('section', 'view-landing');

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

	const serverField = el('div', 'field');
	const serverLabel = el('label', undefined, 'Server');
	serverLabel.htmlFor = 'server';
	const serverInput = el('input');
	serverInput.type = 'text';
	serverInput.id   = 'server';
	serverInput.placeholder = 'example.com or localhost:1337';
	// Default to the host serving this page: in the single container Caddy serves
	// the SPA and proxies /ws on the same origin, so this is the relay. Editable
	// for a decoupled relay (and the Vite dev port, where the relay is :1337).
	serverInput.value = opts.server ?? location.host;
	serverField.append(serverLabel, serverInput);

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
		errorEl.textContent   = opts.error;
		errorEl.style.display = 'inline';
	} else {
		errorEl.style.display = 'none';
	}
	function showError(msg: string): void {
		errorEl.textContent   = msg;
		errorEl.style.display = 'inline';
	}

	const btnRow    = el('div', 'btn-row');
	const btnCreate = el('button', undefined, 'Create Room');
	const btnCancel = el('button', 'btn-secondary', 'Cancel');

	btnCreate.addEventListener('click', () => {
		const server   = serverInput.value.trim();
		const username = usernameInput.value.trim();
		if (!server || !username) {
			showError('Server and username are required');
			return;
		}
		errorEl.style.display = 'none';
		pendingForm = { mode: 'create', username, server };
		void opts.session.create({
			server,
			username,
			adminToken: tokenInput.value.trim() || undefined,
		});
	});
	btnCancel.addEventListener('click', () => opts.onCancel(usernameInput.value.trim()));

	btnRow.append(btnCreate, btnCancel);
	view.append(usernameField, serverField, advancedToggle, tokenField, errorEl, btnRow);
	return view;
}

export function mountLanding(
	app:     Element,
	session: CovcomSession,
	screen:  Screen & { name: 'landing' },
): () => void {
	clear(app);

	let current: HTMLElement;
	const swap = (next: HTMLElement): void => {
		current.replaceWith(next);
		current = next;
	};

	const showMain = (username?: string): void => {
		pendingForm = null;
		swap(buildMainForm({
			username,
			onCreate: (u) => showCreate(u),
			onJoin: (u) => showJoin(u),
		}));
		(current.querySelector('#username') as HTMLInputElement | null)?.focus();
	};

	const showCreate = (username: string, server?: string, error?: string): void => {
		swap(buildCreateForm({
			session,
			username,
			server,
			error,
			onCancel: (u) => showMain(u),
		}));
		(current.querySelector('#server') as HTMLInputElement | null)?.focus();
	};

	const showJoin = (username: string, inviteText?: string, error?: string): void => {
		swap(buildJoinForm({
			username,
			inviteText,
			error,
			onConnect: (invite, text, uname) => {
				pendingForm = { mode: 'join', username: uname, inviteText: text };
				void session.join(invite, uname);
			},
			onBack: (u) => showMain(u),
		}));
		(current.querySelector('textarea') as HTMLTextAreaElement | null)?.focus();
	};

	current = buildMainForm({
		username: screen.prefill?.username,
		onCreate: (u) => showCreate(u),
		onJoin: (u) => showJoin(u),
	});
	app.appendChild(current);

	// On a fatal error, restore the sub-screen the attempt came from with its
	// entries and the error; otherwise the main form already stands. pendingForm
	// is left intact here so it survives the transient RESET remount that
	// precedes the error-bearing GOTO_LANDING; showMain clears it on an explicit
	// return to the main form, and every attempt overwrites it.
	if (screen.error && pendingForm?.mode === 'create') {
		showCreate(pendingForm.username, pendingForm.server, screen.error);
	} else if (screen.error && pendingForm?.mode === 'join') {
		showJoin(pendingForm.username, pendingForm.inviteText, screen.error);
	} else {
		(current.querySelector('#username') as HTMLInputElement | null)?.focus();
	}

	return (): void => {
		clear(app);
	};
}
