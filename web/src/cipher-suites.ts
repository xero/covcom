/**
 * XChaCha20Cipher with a same-origin pool worker.
 *
 * leviathan-crypto's default SealStreamPool factory spawns a classic worker from
 * a blob: URL. WebKit/Safari refuses a blob: worker under a strict CSP even with
 * `worker-src blob:` present (see ../leviathan-crypto/docs/csp.md), so file
 * transfer breaks there. Overriding createPoolWorker to spawn a same-origin
 * worker lets the policy use `worker-src 'self'`, which works on Chromium,
 * Firefox, and WebKit alike. The CLI does the equivalent in
 * cli/src/cipher-suites.ts with a filesystem-backed worker.
 *
 * The worker file is built by web/build-worker.ts into public/, which Vite copies
 * verbatim (never inlined by vite-plugin-singlefile) and serves at the site root.
 * Resolve it against document.baseURI so it lands next to index.html in dev and
 * prod regardless of the host path. Two reasons it stays inside createPoolWorker
 * rather than at module scope: (1) it touches `document`, so deferring it keeps
 * the module import-safe in non-DOM contexts (e.g. the unit-test harness, which
 * imports the session but never spawns a worker); (2) Vite's worker plugin only
 * rewrites the `new URL(..., import.meta.url)` shape — resolving against
 * document.baseURI sidesteps that rewrite, which under singlefile would otherwise
 * re-inline the worker as a blob:, the very thing we are removing.
 */
import { XChaCha20Cipher } from '@covcom/lib';
import type { CipherSuite } from '@covcom/lib';

export const XChaCha20CipherWeb: CipherSuite = {
	...XChaCha20Cipher,
	createPoolWorker: () => new Worker(new URL('covcom-pool-worker.js', document.baseURI), { type: 'classic' }),
};
