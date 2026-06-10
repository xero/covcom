import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoom, joinRoom, watchCrash } from './helpers.ts';

// File-attachment size sweep across all three engines, the regression net for the
// "Aw, Snap!" renderer crash that large attachments used to cause.
//
// Files stream as a `file-begin` frame then one signed `file-chunk` broadcast per
// FILE_CHUNK_SIZE (64 KiB) slice, so memory and wire stay bounded regardless of
// file size. Every size here must round-trip with no crash.

const SIZES: { label: string; bytes: number }[] = [
	{ label: '64 KiB',  bytes: 64 * 1024 },
	{ label: '1 MiB',   bytes: 1024 * 1024 },
	{ label: '8 MiB',   bytes: 8 * 1024 * 1024 },
	{ label: '16 MiB',  bytes: 16 * 1024 * 1024 },
];

let dir = '';

// Build the fixtures with dd (zero-filled; content is irrelevant to the memory /
// wire behaviour under test) so the genuine picked-file -> File.arrayBuffer path
// runs, rather than an in-memory Buffer round-tripped over CDP.
test.beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'covcom-files-'));
	for (const s of SIZES)
		execFileSync('dd', [
			'if=/dev/zero', `of=${join(dir, fixtureName(s.label))}`,
			`bs=${s.bytes}`, 'count=1',
		], { stdio: 'ignore' });
});

test.afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

function fixtureName(label: string): string {
	return `payload-${label.replace(/[^0-9a-z]+/gi, '_')}.bin`;
}

// Attach a real on-disk fixture through the chat bar's hidden #file-input.
async function attachFromDisk(page: Page, label: string): Promise<string> {
	const name = fixtureName(label);
	await page.locator('#file-input').setInputFiles(join(dir, name));
	return name;
}

for (const { label } of SIZES) {
	test(`attach ${label}: round-trips with no renderer crash`, async ({ browser }) => {
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const alice = await ctxA.newPage();
		const bob   = await ctxB.newPage();

		const crashes: string[] = [];
		watchCrash(alice, 'alice', crashes);
		watchCrash(bob,   'bob',   crashes);

		try {
			const invite = await createRoom(alice, 'alice');
			await joinRoom(bob, 'bob', invite);
			await expect(alice.locator('.view-chat #chat-input')).toBeVisible();

			const name = await attachFromDisk(alice, label);

			// alice renders her own card once the frame is built and queued.
			const selfCard = alice.locator('#chat-history li.msg.self .file-card');
			await expect(selfCard.locator('.file-name')).toHaveText(name, { timeout: 60_000 });

			// bob only renders after the inbound OpenStream finalizes the last chunk
			// (AEAD verified), proving the frame survived the relay and decrypted intact.
			const peerCard = bob.locator('#chat-history li.msg.peer .file-card');
			await expect(peerCard.locator('.file-name')).toHaveText(name, { timeout: 60_000 });

			await expect(bob.locator('#chat-history')).not.toContainText('file decrypt failed');
			expect(crashes, crashes.join(' | ')).toHaveLength(0);
			// both pages still alive and interactive
			await expect(alice.locator('#chat-input')).toBeVisible();
			await expect(bob.locator('#chat-input')).toBeVisible();
		} finally {
			await ctxA.close();
			await ctxB.close();
		}
	});
}
