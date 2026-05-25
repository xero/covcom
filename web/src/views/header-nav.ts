import type { CovcomSession } from '../session.js';
import { dispatch, getState, subscribe } from '../store.js';
import { ICON_FP, ICON_LOG, ICON_EYE_OPEN, ICON_EYE_CLOSED } from '../icons.js';
import { chatIsMounted } from './shell.js';

// Header buttons live here as one subscriber. Each button is a node in
// closure scope; visibility is toggled by adding/removing it from the host
// element. Self-gates on cached state to avoid DOM thrash.
//
// `session` is currently unused by these handlers (everything dispatches a
// UI action), but stays in the signature so future buttons can call session
// methods without rewiring the call site.
export function mountHeaderNav(host: Element, _session: CovcomSession): () => void {
	const fpBtn = document.createElement('button');
	fpBtn.type = 'button';
	fpBtn.className = 'fp-badge';
	fpBtn.title = 'Show session fingerprint for out-of-band verification';
	fpBtn.setAttribute('aria-label', 'Show session fingerprint');
	fpBtn.innerHTML = ICON_FP;
	fpBtn.addEventListener('click', () => {
		dispatch({ type: 'SIDEBAR_TOGGLE', section: 'verify' });
	});

	const logBtn = document.createElement('button');
	logBtn.type = 'button';
	logBtn.className = 'event-log-toggle';
	logBtn.title = 'toggle session event log';
	logBtn.setAttribute('aria-label', 'toggle session event log');
	logBtn.innerHTML = ICON_LOG;
	logBtn.addEventListener('click', () => {
		dispatch({ type: 'SIDEBAR_TOGGLE', section: 'event-log' });
	});

	const sysBtn = document.createElement('button');
	sysBtn.type = 'button';
	sysBtn.className = 'btn-toggle-system';
	sysBtn.addEventListener('click', () => {
		dispatch({ type: 'SYSTEM_TOGGLE' });
	});

	function toggleMount(node: HTMLElement, shouldBePresent: boolean): void {
		if (shouldBePresent && !node.isConnected) host.appendChild(node);
		else if (!shouldBePresent && node.isConnected) node.remove();
	}

	let lastFpVisible    = false;
	let lastChatMounted  = false;
	let lastBadgeColor   = '';
	let lastHideSystem: boolean | null = null;
	let lastSidebarOpen   = false;
	let lastActiveSection: 'event-log' | 'verify' | null = null;

	const off = subscribe(() => {
		const s = getState();

		const fpVisible = s.screen.name === 'waiting' || s.screen.name === 'ready';
		if (fpVisible !== lastFpVisible) {
			toggleMount(fpBtn, fpVisible);
			lastFpVisible = fpVisible;
		}
		const badgeColor = s.localFingerprint?.badge ?? '';
		if (fpVisible && badgeColor !== lastBadgeColor) {
			fpBtn.style.backgroundColor = badgeColor;
			lastBadgeColor = badgeColor;
		}

		const showChatButtons = chatIsMounted();
		if (showChatButtons !== lastChatMounted) {
			toggleMount(logBtn, showChatButtons);
			toggleMount(sysBtn, showChatButtons);
			lastChatMounted = showChatButtons;
		}

		// active-state styling for the toggle buttons mirrors sidebarOpen +
		// activeSection so users see which panel a button targets.
		const open    = s.ui.sidebarOpen;
		const section = s.ui.activeSection;
		if (open !== lastSidebarOpen || section !== lastActiveSection) {
			fpBtn.classList.toggle('active',  open && section === 'verify');
			logBtn.classList.toggle('active', open && section === 'event-log');
			lastSidebarOpen   = open;
			lastActiveSection = section;
		}

		if (s.ui.hideSystem !== lastHideSystem) {
			sysBtn.innerHTML = s.ui.hideSystem ? ICON_EYE_CLOSED : ICON_EYE_OPEN;
			sysBtn.title     = s.ui.hideSystem ? 'show system messages' : 'hide system messages';
			lastHideSystem   = s.ui.hideSystem;
		}
	});

	return (): void => {
		off();
		fpBtn.remove();
		logBtn.remove();
		sysBtn.remove();
	};
}
