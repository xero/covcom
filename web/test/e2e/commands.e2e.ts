import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createRoom, joinRoom, sendChat } from './helpers.ts';

// Slash commands and the sidebar keyboard controls, against the real broker +
// Vite + real crypto. A two-party room is the cheapest way to reach the chat-ready
// view (the textarea only appears once a peer has joined) and gives bob a peer so
// `/ratchet` actually rotates. All assertions run on bob's page.

// Read the live sidebar width percent off the inline custom property the sidebar
// writes to `.view-chat`. Polled so we don't race the dispatch -> render tick.
async function expectPct(page: Page, value: number): Promise<void> {
	await expect.poll(async () => page.evaluate(() => {
		const v = document.querySelector('.view-chat');
		if (!(v instanceof HTMLElement)) return NaN;
		return parseFloat(v.style.getPropertyValue('--sidebar-pct'));
	})).toBe(value);
}

test('slash commands: help, unknown, sidebar toggles, ratchet', async ({ browser }) => {
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const alice = await ctxA.newPage();
	const bob   = await ctxB.newPage();

	try {
		const invite = await createRoom(alice, 'alice');
		await joinRoom(bob, 'bob', invite);
		await expect(alice.locator('.view-chat #chat-input')).toBeVisible();

		const history = bob.locator('#chat-history');

		// /help prints the command list as local system lines (bob only).
		await sendChat(bob, '/help');
		await expect(history).toContainText('available commands:');
		await expect(history).toContainText('/exit (/quit, /q, /part)');
		await expect(history).toContainText('toggle verify pane');

		// Unknown command echoes a hint, doesn't send a message.
		await sendChat(bob, '/nope');
		await expect(history).toContainText('unknown command: /nope. type /help for a list');

		// /events opens the event-log panel; /verify switches to it; /verify again closes.
		const sidebar = bob.locator('.view-chat .sidebar');
		await sendChat(bob, '/events');
		await expect(sidebar).toBeVisible();
		await expect(bob.locator('.sidebar [data-section="event-log"]')).toBeVisible();

		await sendChat(bob, '/verify');
		await expect(bob.locator('.sidebar [data-section="verify"]')).toBeVisible();
		await expect(bob.locator('.sidebar [data-section="event-log"]')).toBeHidden();

		await sendChat(bob, '/verify');
		await expect(sidebar).toBeHidden();

		// /ratchet rotates keys (bob has alice as a peer) -> a self "keys rotated"
		// row. A handshake-time rotation may already exist, so match the latest.
		await sendChat(bob, '/ratchet');
		await expect(bob.locator('#chat-history li.msg.self.ratchet').last()).toContainText('keys rotated');
	} finally {
		await ctxA.close();
		await ctxB.close();
	}
});

test('sidebar keyboard: +/- resize (clamped) and Esc close', async ({ browser }) => {
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const alice = await ctxA.newPage();
	const bob   = await ctxB.newPage();

	try {
		const invite = await createRoom(alice, 'alice');
		await joinRoom(bob, 'bob', invite);

		const sidebar   = bob.locator('.view-chat .sidebar');
		const chatInput = bob.locator('#chat-input');

		// Event-log mode: focus a row button (already a tab stop), then resize via
		// keys. The keydown bubbles from the button up to the <aside> listener.
		await sendChat(bob, '/events');
		await expect(bob.locator('.sidebar [data-section="event-log"]')).toBeVisible();
		const row = bob.locator('.event-log-summary').first();
		await expect(row).toBeVisible();
		await row.focus();

		await expectPct(bob, 30);  // default
		await bob.keyboard.press('Shift+Equal');  // '+'
		await expectPct(bob, 35);
		for (let i = 0; i < 10; i++) await bob.keyboard.press('Shift+Equal');
		await expectPct(bob, 70);  // clamps at MAX_PCT
		for (let i = 0; i < 20; i++) await bob.keyboard.press('Minus');
		await expectPct(bob, 10);  // clamps at MIN_PCT

		// Esc closes the panel and hands focus back to the chat input.
		await bob.keyboard.press('Escape');
		await expect(sidebar).toBeHidden();
		await expect(chatInput).toBeFocused();

		// Verify mode has no buttons; the panel's tabindex makes it a tab stop, so
		// the same keys must work after focusing the panel itself.
		await sendChat(bob, '/verify');
		const verify = bob.locator('.sidebar [data-section="verify"]');
		await expect(verify).toBeVisible();
		await verify.focus();
		await bob.keyboard.press('Shift+Equal');  // 10 -> 15
		await expectPct(bob, 15);
		await bob.keyboard.press('Escape');
		await expect(sidebar).toBeHidden();
		await expect(chatInput).toBeFocused();
	} finally {
		await ctxA.close();
		await ctxB.close();
	}
});

test('keys-display: Escape opens the modal, every action closes it and returns to the input', async ({ browser }) => {
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const alice = await ctxA.newPage();
	const bob   = await ctxB.newPage();

	try {
		const invite = await createRoom(alice, 'alice');
		await joinRoom(bob, 'bob', invite);

		const chatInput = bob.locator('#chat-input');
		const keys      = bob.locator('#keys');
		const sidebar   = bob.locator('.view-chat .sidebar');
		await expect(chatInput).toBeVisible();
		// the input is focused on chat start, no click needed
		await expect(chatInput).toBeFocused();

		// Escape from the input swaps the bar for the keys-display.
		await chatInput.focus();
		await bob.keyboard.press('Escape');
		await expect(keys).toBeVisible();
		await expect(chatInput).toBeHidden();

		// 'e' opens the event-log panel, then closes the modal and refocuses the input.
		await bob.keyboard.press('e');
		await expect(bob.locator('.sidebar [data-section="event-log"]')).toBeVisible();
		await expect(keys).toBeHidden();
		await expect(chatInput).toBeFocused();
		await expect(sidebar).toBeVisible();

		// Escape again then 'r' rotates keys (bob has alice as a peer) -> a self
		// "keys rotated" row; the modal closes and the input is refocused.
		await bob.keyboard.press('Escape');
		await expect(keys).toBeVisible();
		await bob.keyboard.press('r');
		await expect(bob.locator('#chat-history li.msg.self.ratchet').last()).toContainText('keys rotated');
		await expect(keys).toBeHidden();
		await expect(chatInput).toBeFocused();

		// Escape opens, Escape closes (no action).
		await bob.keyboard.press('Escape');
		await expect(keys).toBeVisible();
		await bob.keyboard.press('Escape');
		await expect(keys).toBeHidden();
		await expect(chatInput).toBeFocused();
	} finally {
		await ctxA.close();
		await ctxB.close();
	}
});

test('/exit leaves the room, and the session is reusable without a reload', async ({ browser }) => {
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const alice = await ctxA.newPage();
	const bob   = await ctxB.newPage();

	try {
		const invite = await createRoom(alice, 'alice');
		await joinRoom(bob, 'bob', invite);

		await sendChat(bob, '/exit');
		await expect(bob.locator('.view-landing')).toBeVisible();

		// No page.goto: rejoin straight from the landing screen to prove dispose()
		// left the session reusable (the GOTO_LANDING teardown path, not a reload).
		await bob.fill('#username', 'bob');
		await bob.getByRole('button', { name: 'Join Room' }).click();
		await bob.locator('.view-join textarea').fill(invite);
		await bob.locator('.view-join').getByRole('button', { name: 'Join Room' }).click();
		await expect(bob.locator('.view-chat #chat-input')).toBeVisible();
	} finally {
		await ctxA.close();
		await ctxB.close();
	}
});
