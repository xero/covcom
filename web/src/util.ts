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

export function peerColor(colorIdx: number): string {
	if (colorIdx <= 0) return 'var(--peer0)';
	return `var(--peer${1 + ((colorIdx - 1) % 7)})`;
}
