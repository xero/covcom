// Cross-client end-to-end: one relay, a real browser (web client) and the real
// compiled CLI binary in the same room, exchanging encrypted messages both
// ways. The web client and the CLI are independent codebases over a shared
// wire format and @covcom/lib crypto; this is the only test that proves they
// interoperate.
//
// Orchestrated under `bun test` (not @playwright/test, which does not support
// Bun): the playwright *core* library drives Chromium, and Bun's native PTY
// (see tui-runner.ts) drives the CLI. Run via `bun run test:cross`.
//
// Direction: web creates the room (its armored invite reads cleanly off the
// DOM) and the CLI joins from a temp .room file. Asserts the fingerprints
// cross-match (the E2EE handshake agreed), that a message survives the trip
// each way, and that real files attach and decrypt byte-for-byte in both
// directions.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { startCliSession, type CliSession } from './tui-runner.ts';

const SERVER   = '127.0.0.1:1337';
const WEB_URL  = 'http://127.0.0.1:4173';
const HEALTH   = 'http://127.0.0.1:1337/health_check';
const ROOT     = process.cwd();
const CLI_BIN  = resolve(ROOT, 'cli/dist/covcom');
const WEB_DIST = resolve(ROOT, 'web/dist/index.html');

const hex16 = /[0-9a-f]{16}/g;
const norm  = (s: string): string => s.replace(/[^0-9a-f]/gi, '').toLowerCase();
const nonce = (): string => Math.random().toString(36).slice(2, 8);

// deterministic multi-chunk payload: byte i = (i + seed) % 251. The prime stride
// dodges any periodicity aligned to the 64 KiB chunk boundary, so a dropped or
// swapped chunk shifts the bytes and fails the equality check.
const payload = (size: number, seed: number): Buffer => {
	const b = Buffer.allocUnsafe(size);
	for (let i = 0; i < size; i++) b[i] = (i + seed) % 251;
	return b;
};

let browser: Browser;
let page:    Page;
let cli:     CliSession;
let relay:   ReturnType<typeof Bun.spawn>;
let webSrv:  ReturnType<typeof Bun.spawn>;
let tmp:     string;

async function waitHttp(url: string, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			if ((await fetch(url)).ok) return;
		} catch { /* not up yet */ }
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
		await Bun.sleep(200);
	}
}

beforeAll(async () => {
	if (!existsSync(WEB_DIST)) throw new Error('web/dist missing - run `bun run build:web` first');
	if (!existsSync(CLI_BIN))  throw new Error('cli/dist/covcom missing - run `bun run build:cli` first');

	relay = Bun.spawn(['bun', 'run', 'start:server'], {
		cwd: ROOT,
		env: { ...process.env, PORT: '1337', MAX_ROOM_SIZE: '20' },
		stdout: 'ignore', stderr: 'ignore',
	});
	webSrv = Bun.spawn(['bunx', 'serve', 'web/dist', '-l', '4173'], {
		cwd: ROOT, stdout: 'ignore', stderr: 'ignore',
	});
	await Promise.all([waitHttp(HEALTH), waitHttp(WEB_URL)]);

	browser = await chromium.launch({ headless: true });
	page    = await browser.newPage();
	tmp     = mkdtempSync(join(tmpdir(), 'covcom-cross-'));
}, 90_000);

afterAll(async () => {
	cli?.close();
	await browser?.close();
	relay?.kill();
	webSrv?.kill();
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('web and CLI clients exchange end-to-end encrypted messages through the relay', async () => {
	// web Alice creates the room, hand the invite to the CLI via a file. The
	// landing takes only a username; Create Room opens the create sub-screen
	// where the server field lives, then Create Room again connects.
	await page.goto(`${WEB_URL}/`);
	await page.fill('#username', 'alice-web');
	await page.getByRole('button', { name: 'Create Room' }).click();
	await page.fill('#server', SERVER);
	await page.getByRole('button', { name: 'Create Room' }).click();

	const inviteBlock = page.locator('.view-waiting .invite-block');
	await inviteBlock.waitFor({ state: 'visible', timeout: 15_000 });
	const invite = (await inviteBlock.textContent())?.trim();
	if (!invite) throw new Error('web invite block was empty');

	const roomFile = join(tmp, 'room.room');
	const cfgDir   = join(tmp, 'config');
	mkdirSync(cfgDir, { recursive: true });
	writeFileSync(roomFile, invite);
	writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ username: 'bob-cli' }), { flag: 'w' });

	// CLI Bob joins. With `--config` pointing at a file that carries a
	// username, `--join` routes straight to JoinView. The auto-load of the
	// prefill path does not repaint, so we drive the Browse button (deterministic
	// read into the textarea + repaint) and wait for the armored text before
	// joining. There is no separate parse step: Join Room parses the textarea
	// and connects in one action.
	// cwd is the temp dir so files the CLI saves on receive land there (and are
	// cleaned up in afterAll), never in the repo. Absolute paths (roomFile, the
	// attached file) are unaffected.
	cli = startCliSession(CLI_BIN, ['--config', join(cfgDir, 'config.json'), '--join', roomFile], {
		cwd: tmp,
	});
	await cli.waitFor('Path to .room file:');   // JoinView mounted (username focused)

	// The CLI reads one keystroke per stdin chunk, so every key is its own write.
	// Focus ring: username -> path -> browse -> invite -> join -> cancel.
	await cli.write('\t');  // username -> path
	await cli.write('\t');  // path -> browse
	await cli.write('\r');  // Browse: read file into textarea + repaint
	await cli.waitFor(/BEGIN COVCOM INVITE/);  // textarea populated
	await cli.write('\t');  // browse -> invite
	await cli.write('\t');  // invite -> join
	await cli.write('\r');  // Join Room: parse + connect

	// readiness: web Alice drops into chat once the handshake completes; the
	// CLI is ready once its post-connect auto-ratchet renders "keys rotated"
	// (state.ts doConnect). Gating the first send on this avoids the relay
	// dropping a broadcast that arrives before the CLI reaches phase 'ready'.
	await page.locator('.view-chat #chat-input').waitFor({ state: 'visible', timeout: 30_000 });
	await page.locator('#chat-history').getByText('bob-cli joined').first().waitFor({ state: 'visible', timeout: 15_000 });
	await cli.waitFor('keys rotated', 30_000);

	// fingerprints must cross-match: what the web shows for its peer is the
	// CLI's own fingerprint, and vice versa, proving a shared session.
	await page.locator('.fp-badge').click();
	const webHex = page.locator('.sidebar .fp-hex');
	await webHex.nth(1).waitFor({ state: 'visible', timeout: 15_000 });
	const webSelf = norm((await webHex.nth(0).textContent()) ?? '');
	const webPeer = norm((await webHex.nth(1).textContent()) ?? '');

	const vMark = cli.rawLen();
	await cli.write('/verify');   // open verify pane via slash command
	await cli.write('\r');
	await cli.waitFor(/[0-9a-f]{16}[\s\S]*?[0-9a-f]{16}/, 15_000, vMark);
	const cliHexes = cli.screenFrom(vMark).match(hex16) ?? [];
	const cliSelf  = norm(cliHexes[cliHexes.length - 2] ?? '');
	const cliPeer  = norm(cliHexes[cliHexes.length - 1] ?? '');

	expect(webSelf).not.toBe('');
	expect(cliSelf).not.toBe('');
	expect(webPeer).toBe(cliSelf);
	expect(cliPeer).toBe(webSelf);
	expect(webSelf).not.toBe(cliSelf);

	// web -> CLI
	const fromWeb = `ping-from-web-${nonce()}`;
	await page.fill('#chat-input', fromWeb);
	await page.locator('#chat-input').press('Enter');
	await cli.waitFor(fromWeb, 20_000);

	// CLI -> web. Opening the verify pane moved focus to the sidebar; Escape
	// from the focused-open sidebar closes the pane and returns focus to
	// chatInput. Multi-char text arrives as one paste event; Enter must be a
	// separate keystroke to submit.
	const fromCli = `pong-from-cli-${nonce()}`;
	await cli.write('\x1b');      // Escape: close verify pane -> focus chatInput
	await cli.write(fromCli);
	await cli.write('\r');
	await page.locator('#chat-history li.msg.peer:not(.ratchet) .msg-text')
		.filter({ hasText: fromCli })
		.waitFor({ state: 'visible', timeout: 20_000 });
}, 120_000);

// CLI -> web file transfer: the CLI attaches a real multi-chunk file and the web
// peer must receive AND decrypt it. The file card only renders after the final
// chunk's AEAD finalize() succeeds, and downloading the decrypted blob to compare
// bytes additionally proves correct multi-chunk reassembly. Reuses the connected
// session: CLI in chat, focus on chatInput.
test('CLI attaches a real file; web peer receives and decrypts it byte-for-byte', async () => {
	const original = payload(100 * 1024, 0);   // ~100 KiB -> 2 chunks (pull + finalize)
	const filePath = join(tmp, 'cli-to-web.bin');
	writeFileSync(filePath, original);

	await cli.write('\t');         // chatInput -> sendBtn
	await cli.write('\t');         // sendBtn   -> attachBtn
	await cli.write('\r');         // open FilePicker (pathInput focused)
	await cli.write(filePath);     // paste the absolute path
	await cli.write('\r');         // confirm: path exists -> doSendFile streams it

	const card = page.locator('#chat-history li.msg.peer .file-card')
		.filter({ hasText: 'cli-to-web.bin' });
	await card.waitFor({ state: 'visible', timeout: 30_000 });

	// The Download button builds a blob: URL from the decrypted blob; Playwright
	// captures the resulting download so we can read the bytes back off disk.
	const [dl] = await Promise.all([
		page.waitForEvent('download'),
		card.locator('.btn-download').click(),
	]);
	const got = readFileSync(await dl.path());
	expect(got.equals(original)).toBe(true);
}, 60_000);

// web -> CLI file transfer: the web client attaches via its hidden file input
// and the CLI must receive + decrypt. We drive the CLI's keyboard download,
// focus the message area (which auto-selects the latest attachment), Enter to
// save, then compare the file's bytes.
// The CLI's cwd is the temp dir, so the save test stays out of the repo.
test('web attaches a real file; CLI receives, decrypts, and saves it byte-for-byte', async () => {
	const original = payload(70_000, 117);  // ~70 KB -> 2 chunks
	await page.locator('#file-input').setInputFiles({
		name: 'web-to-cli.bin', mimeType: 'application/octet-stream', buffer: original,
	});

	await cli.waitFor('web-to-cli.bin', 30_000);   // chip rendered => decrypt finalized

	await cli.write('\t');   // chatInput -> sendBtn
	await cli.write('\t');   // sendBtn   -> attachBtn
	await cli.write('\t');   // attachBtn -> rotateBtn
	await cli.write('\t');   // rotateBtn -> msgArea (selectLatest picks the file)
	await cli.write('\r');   // Enter -> triggerSelectedDownload saves to cwd (tmp)

	await cli.waitFor('File Downloaded', 15_000);
	const saved = readFileSync(join(tmp, 'web-to-cli.bin'));
	expect(saved.equals(original)).toBe(true);

	await cli.write('\r');   // dismiss the modal
	await cli.write('\x1b'); // Escape: msgArea -> chatInput, clean for the next test
}, 60_000);

// Regression for the attach-a-ghost bug: the FilePicker tab-completes paths, but
// Bun.file() on a path that does not exist reports size 0 rather than throwing,
// so confirming a bogus path used to broadcast a 0-byte file. The fix validates
// the resolved path on Enter and pops a "File Not Found" modal instead. Reuses
// the session from the test above: the CLI is connected, in chat, focus on the
// chat input. We never assert the *absence* of a file on the web side (proving a
// negative is flaky); the modal rendering is the positive proof the send aborted.
test('CLI attach rejects a nonexistent path with a modal instead of sending a 0-byte file', async () => {
	const mark = cli.rawLen();
	await cli.write('\t');   // chatInput -> sendBtn
	await cli.write('\t');   // sendBtn   -> attachBtn
	await cli.write('\r');   // activate attach -> FilePicker opens, pathInput focused
	await cli.write('./definitely-not-a-real-file');   // paste a path that resolves to nothing
	await cli.write('\r');   // confirm: the new guard validates the path here

	await cli.waitFor('File Not Found', 10_000, mark);
	expect(cli.screenFrom(mark)).toContain('No file exists at');

	await cli.write('\r');   // dismiss the modal
	await cli.write('\x1b'); // Escape: exit the still-open picker, leaving a clean state
}, 60_000);
