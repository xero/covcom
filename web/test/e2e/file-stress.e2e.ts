import { expect, test } from '@playwright/test';
import { createRoom, joinRoom, sendAndClassify, timeStep, watchCrash } from './helpers.ts';
import { MiB, transferTimeout } from './timing.ts';

// Large-attachment round-trips, the at-scale proof that chunked streaming fixed
// the "Aw, Snap!" crash. GATED behind COVCOM_STRESS=1 so `bun test:e2e` never
// pushes gigabytes through three browsers unattended. Run it explicitly, one
// worker at a time so only one giant renderer is live:
//
//   COVCOM_STRESS=1 bunx playwright test file-stress --workers=1
//
// Before the fix WebKit crashed at 512 MiB (and the broker dropped anything past
// ~12 MiB). Now every size must round-trip: alice streams it as bounded chunks
// and bob reassembles and renders the file card. Each size is its own test per
// engine so the report pinpoints any regression.
//
// The bytes are synthesized inside alice's page (helpers.attachSynthFile), so the
// source allocation lives in the renderer under test rather than crossing the
// Node/CDP bridge.

const SIZES: { label: string; bytes: number; wireLabel: string }[] = [
	{ label: '64 MiB',  bytes: 64 * MiB,   wireLabel: '64.0 MB' },
	{ label: '180 MiB', bytes: 180 * MiB,  wireLabel: '180.0 MB' },
	{ label: '512 MiB', bytes: 512 * MiB,  wireLabel: '512.0 MB' },
	{ label: '1 GiB',   bytes: 1024 * MiB, wireLabel: '1.0 GB' },
];

for (const { label, bytes, wireLabel } of SIZES) {
	test(`stress attach ${label}: round-trips with no crash`, async ({ browser, browserName }, testInfo) => {
		test.skip(process.env.COVCOM_STRESS !== '1', 'set COVCOM_STRESS=1 to run the stress sweep');

		// Per-engine budget scaled by size; testInfo adds setup/teardown room and
		// stays well inside the job's 45-minute limit even for firefox 1 GiB.
		const transferTimeoutMs = transferTimeout(bytes, browserName);
		testInfo.setTimeout(transferTimeoutMs + 120_000);

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

			const name    = `stress-${label.replace(/\s+/g, '')}.bin`;
			const outcome = await timeStep(
				`${browserName} ${label} sender classify`,
				() => sendAndClassify(alice, name, 'application/octet-stream', bytes, transferTimeoutMs),
			);
			expect(outcome, `${label} alice send outcome`).toBe('ok');

			// bob only renders after every chunk decrypts and OpenStream.finalize
			// verifies the stream, so a visible peer card is proof of an intact
			// end-to-end transfer.
			const peerCard = bob.locator('#chat-history li.msg.peer .file-card').filter({ hasText: name });
			await timeStep(
				`${browserName} ${label} receiver render`,
				() => expect(peerCard.locator('.file-name')).toHaveText(name, { timeout: transferTimeoutMs }),
			);
			await expect(peerCard.locator('.file-meta')).toContainText(wireLabel);
			await expect(bob.locator('#chat-history')).not.toContainText('file decrypt failed');

			expect(crashes, `${label} crashed: ${crashes.join(' | ')}`).toHaveLength(0);
			await expect(alice.locator('#chat-input')).toBeVisible();
			await expect(bob.locator('#chat-input')).toBeVisible();
		} finally {
			await ctxA.close();
			await ctxB.close();
		}
	});
}

// Two recipients exercise the slowest-peer pacing path: the sender holds within
// WINDOW of min(acked) across bob AND carol, so a transfer this far past the
// window only completes if credit from both peers advances. 180 MiB (~2880
// frames) is the real-world case and is many windows deep. Same COVCOM_STRESS gate.
test('stress attach 180 MiB to two recipients: both round-trip with no crash', async ({ browser, browserName }, testInfo) => {
	test.skip(process.env.COVCOM_STRESS !== '1', 'set COVCOM_STRESS=1 to run the stress sweep');

	const bytes = 180 * MiB;
	const transferTimeoutMs = transferTimeout(bytes, browserName);
	testInfo.setTimeout(transferTimeoutMs + 120_000);

	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const ctxC = await browser.newContext();
	const alice = await ctxA.newPage();
	const bob   = await ctxB.newPage();
	const carol = await ctxC.newPage();

	const crashes: string[] = [];
	watchCrash(alice, 'alice', crashes);
	watchCrash(bob,   'bob',   crashes);
	watchCrash(carol, 'carol', crashes);

	try {
		const invite = await createRoom(alice, 'alice');
		await joinRoom(bob,   'bob',   invite);
		await joinRoom(carol, 'carol', invite);
		await expect(alice.locator('.view-chat #chat-input')).toBeVisible();

		const name    = 'stress-180MiB-2rcpt.bin';
		const outcome = await timeStep(
			`${browserName} 180 MiB 2-recipient sender classify`,
			() => sendAndClassify(alice, name, 'application/octet-stream', bytes, transferTimeoutMs),
		);
		expect(outcome, '180 MiB 2-recipient alice send outcome').toBe('ok');

		for (const [who, page] of [['bob', bob], ['carol', carol]] as const) {
			const peerCard = page.locator('#chat-history li.msg.peer .file-card').filter({ hasText: name });
			await timeStep(
				`${browserName} 180 MiB 2-recipient receiver render ${who}`,
				() => expect(peerCard.locator('.file-name'), `${who} peer card`).toHaveText(name, { timeout: transferTimeoutMs }),
			);
			await expect(peerCard.locator('.file-meta')).toContainText('180.0 MB');
			await expect(page.locator('#chat-history')).not.toContainText('file decrypt failed');
		}

		expect(crashes, `2-recipient crashed: ${crashes.join(' | ')}`).toHaveLength(0);
	} finally {
		await ctxA.close();
		await ctxB.close();
		await ctxC.close();
	}
});
