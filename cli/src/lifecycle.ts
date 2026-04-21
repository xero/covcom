let cleanup: (() => void) | null = null;

export function registerCleanup(fn: () => void): void {
	cleanup = fn;
}

export function doCleanup(): void {
	if (cleanup) {
		cleanup(); cleanup = null;
	}
}
