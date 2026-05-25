import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';
import { createRoom, joinRoom, sendFile } from './helpers.ts';

// Encrypted file transfer under the production CSP, across all three engines.
//
// This is the load-bearing Safari/WebKit regression test. File send/receive uses
// SealStreamPool, whose default factory spawns a blob: worker — refused by WebKit
// under a strict CSP even with `worker-src blob:`. XChaCha20CipherWeb instead
// spawns a same-origin worker (covcom-pool-worker.js) under `worker-src 'self'`.
// If that worker can't start, alice's pool.seal rejects and bob never gets the
// file, so the assertions below fail. The webkit project is the real proof.

// Collect real CSP violations; WebKit logs refused worker spawns to the console.
// Match the violation vocabulary (refused / blocked / violates) rather than the
// mere phrase "Content Security Policy", which also appears in the benign
// "frame-ancestors is ignored when delivered via a meta element" advisory that
// every engine emits for our meta-tag CSP (see leviathan-crypto/docs/csp.md).
function watchCsp(page: Page, sink: string[]): void {
	const re = /\b(refused|blocked|violates)\b/i;
	page.on('console', (m: ConsoleMessage) => { if (re.test(m.text())) sink.push(m.text()); });
	page.on('pageerror', (e) => { if (re.test(e.message)) sink.push(e.message); });
}

test('alice sends bob an encrypted file via the same-origin pool worker', async ({ browser }) => {
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const alice = await ctxA.newPage();
	const bob   = await ctxB.newPage();

	const cspHits: string[] = [];
	watchCsp(alice, cspHits);
	watchCsp(bob, cspHits);

	try {
		const invite = await createRoom(alice, 'alice');
		await joinRoom(bob, 'bob', invite);
		await expect(alice.locator('.view-chat #chat-input')).toBeVisible();

		// >1 chunk (chunkSize is 64 KiB) so the parallel pool genuinely runs.
		const bytes = new Uint8Array(200_000);
		for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
		await sendFile(alice, 'secret.bin', 'application/octet-stream', bytes);

		// A peer file-card only renders after pool.open succeeds (AEAD verified),
		// which requires the worker to have spawned and round-tripped.
		const card = bob.locator('#chat-history li.msg.peer .file-card');
		await expect(card.locator('.file-name')).toHaveText('secret.bin');
		await expect(card.locator('.file-meta')).toContainText('195.3 KB');

		// No silent decrypt failure on either side.
		await expect(bob.locator('#chat-history')).not.toContainText('file decrypt failed');
		expect(cspHits, `CSP violations: ${cspHits.join(' | ')}`).toHaveLength(0);
	} finally {
		await ctxA.close();
		await ctxB.close();
	}
});
