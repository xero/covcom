# Testing

> [!NOTE]
> How covcom is tested across the relay, the shared crypto library, and the two
> clients. Covers the cross-client interop test, the per-package unit suites, the
> browser end-to-end suite, and how all of it runs in CI.

> ### Table of Contents
> - [The test layers](#the-test-layers)
> - [Unit tests](#unit-tests)
> - [Web end-to-end](#web-end-to-end)
> - [Cross-client end-to-end](#cross-client-end-to-end)
>   - [What it covers](#what-it-covers)
>   - [How it works](#how-it-works)
>   - [Driving the CLI](#driving-the-cli)
>   - [Running it](#running-it)
> - [Continuous integration](#continuous-integration)
> - [Running tests locally](#running-tests-locally)

---

## The test layers

covcom has four kinds of tests, each with a different job.

**Unit.** Per-package suites under Bun's runner. Fast, isolated, no network.

**Web end-to-end.** Playwright against a real browser, the real relay, and real
crypto. Covers the web client's full path.

**Cross-client.** The web and CLI clients in one room, described above. Covers
message and file-transfer interop between the two clients.

**Docker build.** CI builds the production image to catch packaging breakage. It
does not push on a pull request.

---

## Unit tests

Each package keeps its tests beside its source and runs them with `bun test`. The
suites are fast, isolated, and never touch the network. A few kinds of test recur
across every package:

- **Round-trips.** Encode then decode, seal then open, serialize then parse.
  Bytes in must equal bytes out.
- **Negative and tamper tests.** A flipped ciphertext byte, a wrong counter, a
  forged signature, a truncated buffer, or a mismatched version must be rejected,
  not silently accepted.
- **Security and injection.** Peer-controlled strings cannot drive the terminal
  or the DOM. Bidi overrides, zero-width spoofing, and control characters are
  stripped or refused; markup renders as inert text, never live elements.
- **Adversarial input.** Pathological markup (marker soup, deep nesting, 10k
  backticks) completes in linear time and stays within a hard span cap.

What each suite owns:

- **`lib/test/`** is the crypto correctness layer, real leviathan-crypto with no
  mocks. It covers identity claims and fingerprints, the session ratchet across
  N=2 and N>2, out-of-order delivery and the skipped-key store, epoch math and
  late-join sync, teardown and key wiping, the invite codec, chunked file
  transfer with AEAD integrity, the markup parser, and unicode sanitizing.
- **`server/test/`** drives a live in-process relay over real WebSockets. It
  covers message routing (relay, broadcast, and ratchet fan-out), room lifecycle,
  capacity, and persistence, the auth gates (`ADMIN_TOKEN`, unauthenticated-sender
  drops, the second-join guard), identify validation (length, unicode, bidi, and
  control-char rejection), protocol-version negotiation, and the HTTP routes.
  Because the server stores nothing, these assert routing and rejection, never
  payload content.
- **`web/test/`** runs under `bun test` with a happy-dom DOM and an in-memory
  WebSocket broker. The broker (`mock-ws.ts`) mirrors the server's routing exactly,
  so two real `CovcomSession` instances complete a full handshake and exchange real
  ciphertext in-process, no browser and no relay. It covers the store reducer, the
  session protocol path, the bridge that maps session events to store actions, view
  mounting and interaction, rich-text rendering with an XSS allowlist oracle, the
  safe-HTML sink (plus a lint that no raw HTML-string sink exists outside it), and
  wire-summary redaction.
- **`cli/test/`** exercises the TUI logic in isolation with no real terminal. It
  covers input parsing (escape sequences, bracketed paste, mouse), the focus ring,
  widget behavior, terminal-injection sanitizing, markup-to-SGR rendering with CJK
  and surrogate-pair column wrapping, the event-log ring buffer, wire summaries, and
  config I/O under the `--clean` and `--anon` paranoia flags. The session state
  machine is driven by a fake WebSocket paired with a real-crypto peer, so create,
  join, handshake, the welcome ratchet, and streamed file send all run end to end
  without a server.

The web and CLI suites each load a preload that sets up their harness. `web/test/setup.ts`
registers happy-dom globals so DOM-building code runs without a browser.
`cli/test/setup.ts` points `COVCOM_CONFIG_DIR` at a throwaway temp directory before
any test runs, so the suite never reads or overwrites your real
`~/.config/covcom/config.json`.

Run one package or all of them:

```sh
bun run test:lib        # one package
bun run test            # server, lib, web, and cli
```

> [!IMPORTANT]
> Run the suites through `bun run test`, not a bare `bun test` from the repo
> root. The package scripts set the working directory and preload each suite
> needs.

---

## Web end-to-end

The Playwright suite lives in `web/test/e2e/` and uses a `.e2e.ts` suffix so
Bun's runner never picks it up as a unit test. `playwright.config.ts` starts the
relay on port 1337 and serves the built client on port 4173 before any test runs.

- **`two-party-chat.e2e.ts`** is the happy path. Alice creates a room, Bob joins,
  both exchange encrypted messages, and their fingerprints agree.
- **`file-sizes.e2e.ts`** sweeps attachment sizes to guard against renderer
  crashes on large files.
- **`file-stress.e2e.ts`** pushes large attachments across all three engines with
  per-engine timing budgets.
- **`csp-file-transfer.e2e.ts`** proves encrypted file transfer works under the
  strict Content Security Policy with no worker.

Tests run against Chromium, Firefox, and WebKit. Rooms are ephemeral, so each
test gets a fresh room and no cleanup is needed.

The stress sweep is budgeted, not fixed-timeout. `web/test/e2e/timing.ts` holds one
per-engine ms/MiB model that both the test and the CI summary read, so a transfer
budget and the headroom report cannot drift apart. Firefox gets the largest budget
because Playwright's bundled Firefox runs WASM far slower than the build users
install; that allowance is a Playwright artifact, not a sign covcom is slow for real
Firefox users.

```sh
bunx playwright install --with-deps chromium   # once per machine, per engine
bun run test:e2e                               # all engines
bunx playwright test --project=chromium        # one engine
```
---

## Cross-client end-to-end

The web client and the CLI client are independent codebases. They share only the
wire protocol and the `@covcom/lib` crypto. A drift in encoding or protocol
between them passes every per-package test and only breaks for a real user who
runs one of each. The cross-client test closes that gap. It boots the relay,
connects a real browser and the real compiled CLI binary to the same room, and
exercises both messages and file attachments in each direction.

Lives at `web/test/cross/`. The test is `web-cli.cross.ts`; the PTY helper that
drives the CLI is `tui-runner.ts`. The `.cross.ts` suffix keeps it out of both
Playwright's `*.e2e.ts` glob and Bun's default `*.test.ts` discovery, so it runs
only when you invoke it directly.

### What it covers

The file holds four tests that share one connected session. The first test sets
up the room and both clients; the rest reuse them.

**Message interop.** Alice creates the room, Bob joins, their fingerprints
cross-match, and a message survives each direction, proving both sides derived
the same keys.

**File attach, CLI to web.** The CLI attaches a real file that spans two chunks.
The web peer decrypts it, and the test clicks Download and compares the recovered
bytes to the original. A failed AEAD finalize never renders the card, so a
dropped or reordered chunk fails the byte check.

**File attach, web to CLI.** The web client attaches through its hidden file
input. The CLI decrypts and saves the file, and the test reads it back off disk
and compares the bytes.

**Attach guard.** Confirming a path that does not exist pops a "File Not Found"
modal instead of broadcasting a 0-byte file. This is the regression test for that
bug.

The payload for both file tests is a deterministic buffer whose byte `i` is
`(i + seed) % 251`. The prime stride breaks any periodicity aligned to the 64 KiB
chunk boundary, so a swapped chunk shifts the bytes and the equality check catches
it.

### How it works

One `bun test` process orchestrates both clients.

**Browser.** The test imports the `playwright` core library, `import { chromium }
from 'playwright'`, and launches headless Chromium. It does not use the
`@playwright/test` runner, which Microsoft does not support on Bun.

**CLI.** The test spawns the compiled binary under a pseudo-terminal with Bun's
native `Bun.spawn(cmd, { terminal: { cols, rows, data() } })`. The PTY gives the
CLI a real TTY, so `process.stdin.setRawMode` and `process.stdout.columns` work
exactly as they do for a user. A plain pipe would crash the CLI on startup. The
session's working directory is the test's temp directory, so any file the CLI
saves on receive lands there and is removed in teardown, never in the repo.

**Relay and static host.** `beforeAll` spawns the relay on port 1337 and serves
the built web client on port 4173, then waits for both health endpoints.
`afterAll` tears down the browser, the CLI, both servers, and the temp directory.

The flow proves a shared session, not just that bytes moved:

1. **Web Alice creates the room.** The armored invite reads cleanly off the DOM.
2. **CLI Bob joins** from a temp `.room` file written by the test.
3. **Fingerprints cross-match.** What the web shows for its peer equals the CLI's
   own fingerprint, and the reverse. Both sides derived the same keys.
4. **A message survives each direction**, web to CLI and CLI to web.

The terminal grid is fixed at 120x40. That clears the CLI's 80-column sidebar
threshold so the verify pane renders, and it keeps short messages from wrapping,
which makes the screen scrape deterministic.

### Driving the CLI

The CLI is a custom TUI with no headless mode (see [CLI-SPEC](./CLI-SPEC.md)).
The runner feeds keystrokes with `terminal.write` and reads the screen by
stripping ANSI control sequences from the accumulated PTY output. Because the
buffer is never cleared, a "did this text ever render" check survives the CLI's
full-frame redraws.

The CLI input parser reads one event per stdin chunk, which drives a few rules
the test depends on. Get one wrong and the keystroke does something else.

**One key per write.** Each keystroke is its own `terminal.write`. Three tabs in
a single write do not parse as three tabs; byte `0x09` lands in the ctrl-letter
branch and becomes Ctrl+I.

**Text and Enter are separate.** A multi-character write parses as a single paste
event, so a message and its Enter must be written separately or the newline ends
up inside the pasted text and nothing sends.

**First frame is slow.** WASM crypto init takes one to two seconds before the
first frame paints, so the test polls for it rather than sleeping a fixed amount.

**Join is deterministic.** Passing `--join <file>` with a `COVCOM_CONFIG_DIR`
that carries a username routes straight to the join view. The prefill auto-parse
does not repaint, so the test clicks the Load button and waits for the parsed
`Room:` status line before tabbing to Connect.

**The verify pane steals focus.** Opening it (the keys-display `V`, or `/verify`)
moves focus to the sidebar. The test toggles it back off before typing the reply.

**Readiness has a signal.** The CLI renders `keys rotated` from its post-connect
auto-ratchet once it reaches the ready phase. The test gates the first web to CLI
message on that line, because the relay drops a broadcast that arrives before the
CLI is ready.

**The attach picker is two tabs over.** From the chat input, Tab reaches Send
then Attach; Enter opens the file picker. The test pastes the path and presses
Enter to confirm, which is where the guard validates that the file exists.

**Downloads are keyboard-driven.** The CLI has no download button. Focusing the
message area auto-selects the latest received attachment, and Enter saves it, so
the test tabs to the message area and presses Enter rather than clicking.

### Running it

Build both clients first, then run the test:

```sh
bun run build:web
bun run build:cli
bun run test:cross
```

You also need the Chromium browser binary once per machine:

```sh
bunx playwright install chromium
```

---

## Continuous integration

`.github/workflows/test.yml` runs on every push to `main` and on every pull
request. Every job except `docker` runs inside the `ghcr.io/xero/covcom/ci:latest`
container (built from `.github/ci.Dockerfile`: a Playwright image with Bun and
the browser toolchain baked in), rebuilt by the `ci-image` workflow whenever that
Dockerfile changes on `main`. The `docker` job runs on the bare runner, since it
builds the production image itself.

- **`quality`** runs the linter and the typechecker.
- **`unit`** runs every package's unit suite.
- **`e2e`** runs the Playwright suite across a Chromium, Firefox, and WebKit
  matrix and uploads timing data.
- **`e2e-timing-summary`** parses the timing artifacts into a job summary.
- **`cross-client`** installs Chromium, builds the web client and the CLI binary,
  then runs the cross-client test.
- **`docker`** builds the production image without pushing.

---

## Running tests locally

| Command | What it runs |
| --- | --- |
| `bun run test` | All unit suites: server, lib, web, and cli |
| `bun run test:lib` | The crypto library unit suite |
| `bun run test:server` | The relay unit suite |
| `bun run test:web` | The web client unit suite |
| `bun run test:cli` | The CLI unit suite |
| `bun run test:e2e` | The Playwright web suite across all engines |
| `bun run test:cross` | The cross-client web and CLI interop test |
| `bun run test:all` | Every unit suite plus the web end-to-end suite |
| `bun run typecheck` | Every package and test tsconfig |
| `bun run lint` | ESLint across the repo |

---

## Cross Reference

| Document | Description |
| -------- | ----------- |
| [index](./README.md) | Project Documentation index |
| [USAGE](./USAGE.md) | Client and server applications development and runtime help |
| [PROTOCOL](./PROTOCOL.md) | Cipher, chains, ratchet, group model, session lifecycle, server role |
| [CRYPTOGRAPHY](./CRYPTOGRAPHY.md) | Primitives, KDF chains, wire format, invite encoding |
| [THREAT-MODEL](./THREAT-MODEL.md) | Principals, adversary tiers, guarantees, non-goals |
| [CLI-SPEC](./CLI-SPEC.md) | CLI architecture, rendering, input, widgets, views, and color system |
