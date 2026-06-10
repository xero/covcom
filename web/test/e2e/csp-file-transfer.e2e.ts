import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';
import { createRoom, joinRoom, sendFile } from './helpers.ts';

// Encrypted file transfer under the production CSP, across all three engines.
//
// File send/receive uses leviathan's SealStream / OpenStream on the main
// thread. This test is the load-bearing proof that the strict, worker-free CSP
// doesn't break file transfer on any engine (glares at WebKit  •͡˘㇁•͡˘)

// Collect real CSP violations. Match the violation vocabulary (refused / blocked /
// violates) rather than the mere phrase "Content Security Policy", which also
// appears in the benign "frame-ancestors is ignored when delivered via a meta
// element" advisory every engine emits for our meta-tag CSP.
function watchCsp(page: Page, sink: string[]): void {
	const re = /\b(refused|blocked|violates)\b/i;
	page.on('console', (m: ConsoleMessage) => {
		if (re.test(m.text())) sink.push(m.text());
	});
	page.on('pageerror', (e) => {
		if (re.test(e.message)) sink.push(e.message);
	});
}

test('encrypted file transfer works under the strict, worker-free CSP', async ({ browser }) => {
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

		// The shipped policy must no longer mention worker-src (no worker is spawned).
		const csp = await alice.evaluate(() =>
			document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '');
		expect(csp, 'CSP should be present').toContain('default-src \'none\'');
		expect(csp, 'CSP should not carry worker-src anymore').not.toContain('worker-src');

		// >1 chunk would need >1 MiB; 200 KB is a single final chunk, enough to
		// exercise the full SealStream/OpenStream round-trip under CSP.
		const bytes = new Uint8Array(200_000);
		for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
		await sendFile(alice, 'secret.bin', 'application/octet-stream', bytes);

		// A peer file-card only renders after OpenStream.finalize verifies the
		// stream, which on WebKit proves the worker-free path runs under the CSP.
		const card = bob.locator('#chat-history li.msg.peer .file-card');
		await expect(card.locator('.file-name')).toHaveText('secret.bin');
		await expect(card.locator('.file-meta')).toContainText('195.3 KB');

		await expect(bob.locator('#chat-history')).not.toContainText('file decrypt failed');
		expect(cspHits, `CSP violations: ${cspHits.join(' | ')}`).toHaveLength(0);
	} finally {
		await ctxA.close();
		await ctxB.close();
	}
});
