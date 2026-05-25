import { el } from '../util.js';
import { getState, subscribe } from '../store.js';
import type { EventLogEntry } from '../store.js';
import { sidebarBody } from './sidebar.js';

function fmtTime(ts: number): string {
	const d  = new Date(ts);
	const hh = String(d.getHours()).padStart(2, '0');
	const mm = String(d.getMinutes()).padStart(2, '0');
	const ss = String(d.getSeconds()).padStart(2, '0');
	const ms = String(d.getMilliseconds()).padStart(3, '0');
	return `${hh}:${mm}:${ss}.${ms}`;
}

function cssKind(k: string): string {
	return k.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

function buildRow(entry: EventLogEntry): HTMLElement {
	const row = el('div', `event-log-row collapsed dir-${entry.direction} kind-${cssKind(entry.kind)}`);
	row.dataset.eventId = String(entry.id);

	const summary = document.createElement('button');
	summary.type = 'button';
	summary.className = 'event-log-summary';
	const time = el('span', 'event-log-time', fmtTime(entry.ts));
	const dir  = el('span', 'event-log-dir',  entry.direction);
	const kind = el('span', 'event-log-kind', entry.kind);
	const text = el('span', 'event-log-text');
	text.innerHTML = entry.summary;
	summary.append(time, dir, kind, text);

	const details = document.createElement('table');
	details.className = 'event-log-details';
	const tbody = document.createElement('tbody');
	for (const [k, v] of Object.entries(entry.details)) {
		const tr = document.createElement('tr');
		const th = el('th', undefined, k);
		const td = el('td', undefined, typeof v === 'string' ? v : JSON.stringify(v));
		tr.append(th, td);
		tbody.appendChild(tr);
	}
	details.appendChild(tbody);

	summary.addEventListener('click', () => row.classList.toggle('collapsed'));
	row.append(summary, details);
	return row;
}

export function mountEventLog(view: Element): () => void {
	const body = sidebarBody(view, 'event-log');
	if (!body) return () => { /* sidebar not mounted */ };

	const chain = el('section', 'event-log-chain');
	body.appendChild(chain);

	// Replay any events already in the store (e.g. when chat remounts).
	for (const entry of getState().events) chain.appendChild(buildRow(entry));

	const aside = view.querySelector('.sidebar') as HTMLElement | null;
	let lastId = chain.lastElementChild
		? Number((chain.lastElementChild as HTMLElement).dataset.eventId)
		: 0;
	let wasVisible = !body.hidden;

	const off = subscribe(() => {
		const s = getState();
		// Evict rows whose entries have aged out of the cap.
		const headId = s.events.length > 0 ? s.events[0].id : 0;
		while (chain.firstElementChild) {
			const id = Number((chain.firstElementChild as HTMLElement).dataset.eventId);
			if (id >= headId) break;
			chain.firstElementChild.remove();
		}
		// Append every entry beyond the last seen id.
		let appended = false;
		for (const entry of s.events) {
			if (entry.id <= lastId) continue;
			chain.appendChild(buildRow(entry));
			lastId   = entry.id;
			appended = true;
		}
		const visible = !body.hidden;
		if (visible && (appended || !wasVisible) && aside) {
			aside.scrollTop = aside.scrollHeight;
		}
		wasVisible = visible;
	});

	return (): void => {
		off();
		chain.remove();
	};
}
