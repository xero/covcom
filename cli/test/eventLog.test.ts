import { afterEach, describe, expect, test } from 'bun:test';
import { getEvents, logEvent, resetEvents, subscribeEvents } from '../src/eventLog.ts';

afterEach(() => resetEvents());

const entry = (summary: string) => ({ direction: 'out' as const, kind: 'broadcast', summary, details: {} });

describe('eventLog', () => {
	test('logs in order with incrementing ids and a timestamp', () => {
		logEvent({ ...entry('a'), ts: 100 });
		logEvent(entry('b'));
		const ev = getEvents();
		expect(ev.map(e => e.summary)).toEqual(['a', 'b']);
		expect(ev[0].id).toBe(1);
		expect(ev[1].id).toBe(2);
		expect(ev[0].ts).toBe(100);
		expect(typeof ev[1].ts).toBe('number');
	});

	test('ring buffer caps at 500, evicting oldest while ids keep climbing', () => {
		for (let i = 0; i < 600; i++) logEvent(entry(`m${i}`));
		const ev = getEvents();
		expect(ev.length).toBe(500);
		expect(ev[0].summary).toBe('m100');           // m0..m99 evicted
		expect(ev[ev.length - 1].summary).toBe('m599');
		expect(ev[ev.length - 1].id).toBe(600);        // id is not reset by eviction
	});

	test('subscribers fire on push and on reset', () => {
		let hits = 0;
		const unsub = subscribeEvents(() => hits++);
		logEvent(entry('x'));
		expect(hits).toBe(1);
		resetEvents();
		expect(hits).toBe(2);
		expect(getEvents().length).toBe(0);
		unsub();
		logEvent(entry('y'));
		expect(hits).toBe(2);                          // unsubscribed: no further hits
	});

	test('resetEvents restarts ids at 1', () => {
		logEvent(entry('a'));
		resetEvents();
		logEvent(entry('b'));
		expect(getEvents()[0].id).toBe(1);
	});
});
