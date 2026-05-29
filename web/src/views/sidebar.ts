import type { CovcomSession } from '../session.js';
import { dispatch, getState, subscribe, SIDEBAR_DEFAULTS } from '../store.js';
import { el } from '../util.js';

// Returns the section's body element for sub-views (event-log, verify) to mount
// into. Sidebar guarantees both bodies exist at mount time, so consumers don't
// need a null fallback path for "section not yet created".
export function sidebarBody(view: Element, id: 'event-log' | 'verify'): HTMLElement | null {
	return view.querySelector(`.sidebar [data-section="${id}"]`);
}

export function mountSidebar(view: Element, _session: CovcomSession): () => void {
	const host = view as HTMLElement;
	host.classList.add('no-sidebar');

	const dragbar = el('div', 'sidebar-dragbar');
	dragbar.setAttribute('role', 'separator');
	dragbar.setAttribute('aria-orientation', 'vertical');
	dragbar.setAttribute('aria-label', 'resize sidebar');

	const aside = el('aside', 'sidebar');
	aside.setAttribute('aria-label', 'session sidebar');

	const eventLogBody = el('section', 'sidebar-section');
	eventLogBody.dataset.section = 'event-log';

	const verifyBody = el('section', 'sidebar-section fp-section');
	verifyBody.dataset.section = 'verify';

	aside.append(eventLogBody, verifyBody);

	// Insert before the chat-bar so the grid layout (history | aside | dragbar
	// / bar) lines up; if no bar yet (caller mounts sidebar first), append.
	const bar = host.querySelector('.chat-bar');
	if (bar) {
		host.insertBefore(dragbar, bar);
		host.insertBefore(aside, bar);
	} else {
		host.appendChild(dragbar);
		host.appendChild(aside);
	}

	// drag state: local-only flag so the subscriber knows to skip width writes.
	let dragging  = false;
	let activePtr = -1;

	const onDown = (e: PointerEvent): void => {
		if (e.button !== 0 && e.pointerType === 'mouse') return;
		activePtr = e.pointerId;
		dragbar.setPointerCapture(e.pointerId);
		dragging = true;
		host.classList.add('resizing');
		e.preventDefault();
	};
	const onMove = (e: PointerEvent): void => {
		if (e.pointerId !== activePtr) return;
		const r   = host.getBoundingClientRect();
		const raw = ((r.right - e.clientX) / r.width) * 100;
		const pct = Math.max(SIDEBAR_DEFAULTS.MIN_PCT, Math.min(SIDEBAR_DEFAULTS.MAX_PCT, raw));
		host.style.setProperty('--sidebar-pct', String(pct));
	};
	const onUp = (e: PointerEvent): void => {
		if (e.pointerId !== activePtr) return;
		activePtr = -1;
		dragbar.releasePointerCapture(e.pointerId);
		host.classList.remove('resizing');
		const pct = parseFloat(host.style.getPropertyValue('--sidebar-pct')) || SIDEBAR_DEFAULTS.DEFAULT_PCT;
		dragging = false;
		dispatch({ type: 'SIDEBAR_RESIZE', pct });
	};
	const onDblClick = (): void => {
		dispatch({ type: 'SIDEBAR_RESIZE', pct: SIDEBAR_DEFAULTS.DEFAULT_PCT });
	};

	dragbar.addEventListener('pointerdown',   onDown);
	dragbar.addEventListener('pointermove',   onMove);
	dragbar.addEventListener('pointerup',     onUp);
	dragbar.addEventListener('pointercancel', onUp);
	dragbar.addEventListener('dblclick',      onDblClick);

	// initial apply
	host.style.setProperty('--sidebar-pct', String(getState().ui.sidebarWidthPct));

	let lastOpen:    boolean | null = null;
	let lastSection: 'event-log' | 'verify' | null | undefined = undefined;
	let lastPct = getState().ui.sidebarWidthPct;

	const render = (): void => {
		const ui = getState().ui;
		if (ui.sidebarOpen !== lastOpen || ui.activeSection !== lastSection) {
			aside.hidden        = !ui.sidebarOpen;
			dragbar.hidden      = !ui.sidebarOpen;
			eventLogBody.hidden = !(ui.sidebarOpen && ui.activeSection === 'event-log');
			verifyBody.hidden   = !(ui.sidebarOpen && ui.activeSection === 'verify');
			host.classList.toggle('no-sidebar', !ui.sidebarOpen);
			lastOpen    = ui.sidebarOpen;
			lastSection = ui.activeSection;
		}
		// Skip width writes during a local drag — the pointermove already wrote
		// the live value, and dispatching the same pct back here would race.
		if (!dragging && ui.sidebarWidthPct !== lastPct) {
			host.style.setProperty('--sidebar-pct', String(ui.sidebarWidthPct));
			lastPct = ui.sidebarWidthPct;
		}
	};

	const off = subscribe(render);
	// Apply current state immediately so the sidebar's open/section/width DOM
	// matches getState().ui at mount, not just after the first dispatch.
	render();

	return (): void => {
		off();
		dragbar.remove();
		aside.remove();
		host.classList.remove('no-sidebar', 'resizing');
	};
}
