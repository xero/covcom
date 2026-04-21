/**
 * cipher-suites.ts — XChaCha20Cipher with blob URL pool worker.
 *
 * Bun cannot resolve new URL('./pool-worker.js', import.meta.url) at runtime.
 * Override createPoolWorker() to spawn from a pre-bundled blob URL instead.
 * Workers run in classic (non-module) mode so each gets its own global scope
 * and independent WASM/key state. The bundle is built with format: 'iife'.
 */
import { XChaCha20Cipher }                from 'leviathan-crypto';
import type { CipherSuite }               from 'leviathan-crypto';
import { WORKER_BUNDLE as CHACHA_BUNDLE } from './chacha/worker-bundle.js';

export const XChaCha20CipherBun: CipherSuite = {
	...XChaCha20Cipher,
	createPoolWorker(): Worker {
		const blob = new Blob([CHACHA_BUNDLE], { type: 'text/javascript' });
		const url  = URL.createObjectURL(blob);
		try     {
			return new Worker(url);
		} finally {
			URL.revokeObjectURL(url);
		}
	},
};
