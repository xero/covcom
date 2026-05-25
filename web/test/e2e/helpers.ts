import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

// The relay broker; the web client points at it via the landing "Server" field.
// localhost maps to plaintext ws:// in the client, so no TLS is needed.
export const SERVER = 'localhost:3000';

// alice's path: fill the landing form, create a room, wait for the lobby, and
// return the armored invite text others paste to join.
export async function createRoom(page: Page, username: string): Promise<string> {
	await page.goto('/');
	await page.fill('#server', SERVER);
	await page.fill('#username', username);
	await page.getByRole('button', { name: 'Create Room' }).click();

	const invite = page.locator('.view-waiting .invite-block');
	await expect(invite).toBeVisible();
	const text = await invite.textContent();
	if (!text) throw new Error('invite block was empty');
	return text;
}

// bob's path: set the username on the landing screen, open the join view, paste
// the invite, parse it, and connect. Resolves once the chat view is mounted.
export async function joinRoom(page: Page, username: string, invite: string): Promise<void> {
	await page.goto('/');
	await page.fill('#username', username);
	await page.getByRole('button', { name: 'Join Room' }).click();

	await page.locator('.view-join textarea').fill(invite);
	await page.getByRole('button', { name: 'Parse' }).click();

	const summary = page.locator('.invite-summary');
	await expect(summary).toBeVisible();
	await summary.getByRole('button', { name: 'Connect' }).click();

	await expect(page.locator('.view-chat #chat-input')).toBeVisible();
}

// Type a message into the active chat input and send it with Enter.
export async function sendChat(page: Page, text: string): Promise<void> {
	const input = page.locator('#chat-input');
	await input.fill(text);
	await input.press('Enter');
}

// Attach a file via the chat bar's hidden file input. This drives the encrypted
// file path: session.sendFile → SealStreamPool → createPoolWorker (same-origin
// worker). setInputFiles works on the display:none input.
export async function sendFile(page: Page, name: string, mimeType: string, bytes: Uint8Array): Promise<void> {
	await page.locator('#file-input').setInputFiles({ name, mimeType, buffer: Buffer.from(bytes) });
}

// Open the fingerprint panel and read the hex strings. The verify panel renders
// "You" first (index 0) then one block per peer, so for a two-party session
// fp-hex[0] is self and fp-hex[1] is the single peer.
export async function fingerprints(page: Page): Promise<{ self: string; peer: string }> {
	await page.locator('.fp-badge').click();
	const hexes = page.locator('.sidebar .fp-hex');
	await expect(hexes.nth(1)).toBeVisible();
	const self = (await hexes.nth(0).textContent())?.trim() ?? '';
	const peer = (await hexes.nth(1).textContent())?.trim() ?? '';
	return { self, peer };
}
