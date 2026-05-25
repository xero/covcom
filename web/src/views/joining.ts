import { el, clear } from '../util.js';

// Placeholder view shown between landing and the first ready/waiting emit.
// No subscription — the shell swaps the view out when the screen advances.
export function mountJoining(app: Element): () => void {
	clear(app);
	const view = el('section', 'view-joining');
	const status = el('p', 'status-line', 'connecting…');
	view.appendChild(status);
	app.appendChild(view);

	return (): void => {
		clear(app);
	};
}
