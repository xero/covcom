import type { CovcomSession } from '../session.js';
import { getState, subscribe } from '../store.js';
import type { AppState, Screen } from '../store.js';
import { mountHeaderNav } from './header-nav.js';
import { mountLanding } from './landing.js';
import { mountJoining } from './joining.js';
import { mountWaiting } from './waiting.js';
import { mountChat } from './chat.js';

// Shell-derived view names. Distinct from `screen.name`: chat covers both
// `ready` and (post-handshake) `waiting`, gated by everReady.
type View = 'landing' | 'joining' | 'waiting' | 'chat';

// Closure-local because the latch is a view-orchestration flag, not protocol
// state; it survives the same room visit (ready ↔ waiting) but resets on
// return to landing.
let everReady = false;
let chatMounted = false;

function pickView(s: AppState): View {
	switch (s.screen.name) {
	case 'landing':
		return 'landing';
	case 'joining':
		return 'joining';
	case 'waiting':
		return everReady ? 'chat' : 'waiting';
	case 'ready':
		return 'chat';
	}
}

export function chatIsMounted(): boolean {
	return chatMounted;
}

export function mountShell(app: Element, session: CovcomSession): void {
	const headerHost = document.getElementById('header-nav');
	if (headerHost) mountHeaderNav(headerHost, session);

	let cleanup: (() => void) | null = null;
	let lastView: View | null = null;
	let lastScreen: Screen | null = null;

	const render = (): void => {
		const s = getState();
		// Latch must update before pickView reads it so the same render that
		// observes screen='ready' picks 'chat', not 'waiting'.
		if (s.screen.name === 'ready')   everReady = true;
		if (s.screen.name === 'landing') everReady = false;

		const view = pickView(s);
		// Remount within the same view when the underlying screen object changes,
		// but only for views that capture screen state at mount time (landing's
		// error/prefill, waiting's room). Chat manages its own bar variant.
		const screenChanged = view !== 'chat' && s.screen !== lastScreen;
		if (view === lastView && !screenChanged) return;

		cleanup?.();
		cleanup    = null;
		chatMounted = false;

		switch (view) {
		case 'landing':
			cleanup = mountLanding(app, session, s.screen as Screen & { name: 'landing' });
			break;
		case 'joining':
			cleanup = mountJoining(app);
			break;
		case 'waiting':
			cleanup = mountWaiting(app, session, s.screen as Screen & { name: 'waiting' });
			break;
		case 'chat':
			cleanup     = mountChat(app, session);
			chatMounted = true;
			break;
		}
		lastView   = view;
		lastScreen = s.screen;
	};

	subscribe(render);
	render();
}
