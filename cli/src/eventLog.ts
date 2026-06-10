// In-process event log for the CLI sidebar. Shape mirrors `web/src/store.ts`
// EventLogEntry so the two clients show the same data. Capped ring buffer;
// subscribers fire on every push so the TUI can mark dirty.

export interface EventLogEntry {
	id:        number
	direction: 'in' | 'out' | 'local'
	kind:      string
	summary:   string
	details:   Record<string, unknown>
	ts:        number
}

const CAP        = 500;
const events:    EventLogEntry[]    = [];
const listeners  = new Set<() => void>();
let nextId       = 1;

export function logEvent(e: Omit<EventLogEntry, 'id' | 'ts'> & { ts?: number }): void {
	events.push({
		id: nextId++,
		direction: e.direction,
		kind: e.kind,
		summary: e.summary,
		details: e.details,
		ts: e.ts ?? Date.now(),
	});
	while (events.length > CAP) events.shift();
	for (const fn of listeners) fn();
}

export function getEvents(): readonly EventLogEntry[] {
	return events;
}

export function subscribeEvents(fn: () => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

export function resetEvents(): void {
	events.length = 0;
	nextId        = 1;
	for (const fn of listeners) fn();
}
