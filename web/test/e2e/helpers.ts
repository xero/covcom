import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

// ── crash / large-file diagnostics (file-size investigation) ────────────────

// Chrome's "Aw, Snap!" renderer OOM surfaces in Playwright as a `crash` event.
// Firefox/WebKit usually report a process-gone error on the next call instead.
// Push a marker into `sink` so a test can assert the renderer survived.
export function watchCrash(page: Page, label: string, sink: string[]): void {
	page.on('crash', () => sink.push(`${label}: renderer crashed (page.on('crash'))`));
}

// Synthesize a File of `size` zero-bytes entirely inside the page and feed it to
// the chat bar's #file-input, exactly as a user-picked file would arrive. This
// keeps the allocation in the renderer (where the covcom send-path amplification
// happens) and avoids round-tripping gigabytes through the Node/CDP bridge, which
// setInputFiles with a Buffer would. Returns immediately; the change handler runs
// session.sendFile without awaiting, so the seal/b64enc/JSON work happens after.
export async function attachSynthFile(page: Page, name: string, mime: string, size: number): Promise<void> {
	await page.evaluate(({ name, mime, size }) => {
		const buf   = new Uint8Array(size);
		const file  = new File([buf], name, { type: mime });
		const input = document.getElementById('file-input') as HTMLInputElement | null;
		if (!input) throw new Error('#file-input not found');
		const dt = new DataTransfer();
		dt.items.add(file);
		input.files = dt.files;
		input.dispatchEvent(new Event('change', { bubbles: true }));
	}, { name, mime, size });
}

export type SendOutcome = 'ok' | 'app-error' | 'crash' | 'timeout';

// Drive one send and classify what happened, the load-bearing observation for the
// size sweep. 'ok' = alice's own file-card rendered (seal + frame succeeded, even
// if the relay was later dropped on the wire). 'app-error' = sendFile caught the
// failure and surfaced a "Send failed" system row. 'crash' = renderer died.
// 'timeout' = neither a card nor an error appeared (e.g. socket closed mid-send).
export async function sendAndClassify(
	page: Page, name: string, mime: string, size: number, timeoutMs = 60_000,
): Promise<SendOutcome> {
	const crashed = new Promise<SendOutcome>((res) => page.once('crash', () => res('crash')));
	const card    = page.locator('#chat-history li.msg.self .file-card .file-name')
		.filter({ hasText: name }).first().waitFor({ state: 'visible', timeout: timeoutMs })
		.then<SendOutcome>(() => 'ok').catch<SendOutcome>(() => 'timeout');
	const failed  = page.locator('#chat-history').getByText('Send failed', { exact: false })
		.first().waitFor({ state: 'visible', timeout: timeoutMs })
		.then<SendOutcome>(() => 'app-error').catch<SendOutcome>(() => 'timeout');

	try {
		await attachSynthFile(page, name, mime, size);
	} catch {
		return 'crash';   // evaluate throws when the renderer is already gone
	}
	const winners = await Promise.race([
		crashed,
		Promise.race([card, failed]),
	]);
	return winners;
}

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

// Attach a file via the chat bar's hidden file input. setInputFiles works on
// the display:none input and drives session.sendFile, which seals the file with
// SealStream on the main thread (no worker) and streams it over the relay.
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
