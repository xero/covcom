// Typed event emitter. A Map<eventName, Set<handler>> keyed by the event-map
// type parameter, so on()/emit() are checked against the same payload shapes.
// The unknown cast happens once at registration, not per dispatch. `E` is
// unconstrained because the `consistent-type-definitions` rule wants event
// maps declared as `interface`, and interfaces don't conform to a
// `Record<string, unknown>` constraint (open vs. closed semantics).
export class Emitter<E> {
	private h = new Map<keyof E, Set<(p: unknown) => void>>();

	on<K extends keyof E>(k: K, fn: (p: E[K]) => void): () => void {
		let set = this.h.get(k);
		if (!set) this.h.set(k, set = new Set());
		set.add(fn as (p: unknown) => void);
		return () => set.delete(fn as (p: unknown) => void);
	}

	protected emit<K extends keyof E>(k: K, p: E[K]): void {
		const set = this.h.get(k);
		if (!set) return;
		for (const fn of set) fn(p);
	}
}
