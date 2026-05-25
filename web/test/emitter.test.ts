import { describe, expect, test } from 'bun:test';
import { Emitter } from '../src/emitter.ts';

interface Events {
	ping: { n: number };
	pong: string;
}

// `emit` is protected; a test subclass exposes it so we can drive the emitter.
class TestEmitter extends Emitter<Events> {
	fire<K extends keyof Events>(k: K, p: Events[K]): void {
		this.emit(k, p);
	}
}

describe('Emitter', () => {
	test('delivers the payload to a handler', () => {
		const e = new TestEmitter();
		let got = null as { n: number } | null;
		e.on('ping', (p) => { got = p; });
		e.fire('ping', { n: 7 });
		expect(got).toEqual({ n: 7 });
	});

	test('fans out to multiple handlers on the same key', () => {
		const e = new TestEmitter();
		const seen: number[] = [];
		e.on('ping', (p) => seen.push(p.n));
		e.on('ping', (p) => seen.push(p.n * 10));
		e.fire('ping', { n: 2 });
		expect(seen).toEqual([2, 20]);
	});

	test('on() returns a working unsubscribe', () => {
		const e = new TestEmitter();
		let count = 0;
		const off = e.on('pong', () => count++);
		e.fire('pong', 'a');
		off();
		e.fire('pong', 'b');
		expect(count).toBe(1);
	});

	test('emitting an unhandled key is a no-op', () => {
		const e = new TestEmitter();
		expect(() => e.fire('pong', 'x')).not.toThrow();
	});

	test('handlers on one key are unaffected by another key', () => {
		const e = new TestEmitter();
		let pings = 0;
		e.on('ping', () => pings++);
		e.fire('pong', 'ignored');
		expect(pings).toBe(0);
	});
});
