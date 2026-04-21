export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	cls?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text !== undefined) e.textContent = text;
	return e;
}

export function clear(node: Element): void {
	while (node.firstChild) node.removeChild(node.firstChild);
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function senderColor(index: number): string {
	return `var(--sender-${index % 8})`;
}

export function senderIndex(username: string, known: Map<string, number>): number {
	const existing = known.get(username);
	if (existing !== undefined) return existing;
	const idx = known.size;
	known.set(username, idx);
	return idx;
}
