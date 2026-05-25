import { expect, test } from '@playwright/test';
import { createRoom, fingerprints, joinRoom, sendChat } from './helpers.ts';

// Full two-party happy path against the real broker + Vite + real crypto:
// alice creates a room, bob joins from the invite, both exchange messages that
// must decrypt on the opposite side, and their fingerprints must agree.
test('alice and bob exchange end-to-end encrypted messages', async ({ browser }) => {
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const alice = await ctxA.newPage();
	const bob   = await ctxB.newPage();

	try {
		const invite = await createRoom(alice, 'alice');
		await joinRoom(bob, 'bob', invite);

		// alice transitions from the lobby to the chat view once bob completes
		// the handshake.
		await expect(alice.locator('.view-chat #chat-input')).toBeVisible();

		// each side announces the other's arrival
		await expect(alice.locator('.view-chat')).toContainText('bob joined');
		await expect(bob.locator('.view-chat')).toContainText('alice joined');

		// alice → bob (exclude the ratchet "keys rotated" rows, which are also
		// rendered as peer messages)
		await sendChat(alice, 'hello bob, this is encrypted');
		const bobInbound = bob.locator('#chat-history li.msg.peer:not(.ratchet) .msg-text');
		await expect(bobInbound).toContainText('hello bob, this is encrypted');

		// bob → alice
		await sendChat(bob, 'got it, alice');
		const aliceInbound = alice.locator('#chat-history li.msg.peer:not(.ratchet) .msg-text');
		await expect(aliceInbound).toContainText('got it, alice');

		// fingerprints must cross-match: what alice sees for bob is bob's own
		// fingerprint, and vice versa, proving both derived the same session keys.
		const fpA = await fingerprints(alice);
		const fpB = await fingerprints(bob);
		expect(fpA.peer).toBe(fpB.self);
		expect(fpB.peer).toBe(fpA.self);
		expect(fpA.self).not.toBe(fpB.self);
	} finally {
		await ctxA.close();
		await ctxB.close();
	}
});
