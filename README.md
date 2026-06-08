# COVCOM

```
  ▄██▀ ▀█  ▄██▀ █▄  ▀██  ██▀  ▄██▀ ▀█  ▄██▀ █▄   █▄   ▄█
 ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒  ▒▒  ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒▒▄▒▒▒
 ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒▌ ▒▒  ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒ ▀ ▒▒
  ▀██▄ ▄█  ▀██▄ █▀    ▀█▄▀    ▀██▄ ▄█  ▀██▄ █▀  ▄██▄ ▄██▄

  Covert communications for private group conversations.
  Invite, talk, close the client, and the chat vanishes.
  Every message is encrypted with XChaCha20 and signed
  with Ed25519. A BLAKE3 fingerprint on each key allows
  peers to verify one another. SPQR's manual and epoch
  ratchets add forward secrecy, while post-quantum
  ML-KEM-768 encapsulation keeps recorded communications
  unreadable and secure against future cryptanalysis.
```

## https://xero.github.io/covcom/

[![GitHub Release](https://img.shields.io/github/v/release/xero/covcom?display_name=release&style=flat-square&logo=contributorcovenant&logoColor=%23bcb83a&color=%2378740b)](https://github.com/xero/covcom/releases/latest) [![Container Image Size](https://img.shields.io/docker/image-size/xerostyle/covcom/latest?arch=amd64&style=flat-square&logo=developmentcontainers&logoColor=%23bcb83a&color=%2378740b)](https://hub.docker.com/r/xerostyle/covcom) [![GitHub Wiki Publish](https://img.shields.io/github/actions/workflow/status/xero/covcom/wiki.yml?branch=main&style=flat-square&logo=gitbook&logoColor=%23bcb83a&label=wiki&color=%2378740b)](https://github.com/xero/covcom/wiki) [![MIT Licensed](https://img.shields.io/badge/MIT-License?style=flat-square&logo=internetarchive&logoColor=%23bcb83a&label=License&color=%2378740b)](https://github.com/xero/covcom/blob/main/LICENSE)

> ### Table of Contents
> - [How it works](#how-it-works)
> - [Quickstart](#quickstart)
> - [Requirements](#requirements)
> - [Installation](#installation)
> - [Server](#server)
>   - [Docker](#docker)
>   - [Docker (raw)](#docker-raw)
>   - [Production (no docker)](#production-no-docker)
>   - [Development](#development)
>   - [Environment variables](#environment-variables)
> - [Web client](#web-client)
> - [CLI client](#cli-client)
>   - [Configuration](#configuration)
>   - [Navigation](#navigation)
> - [Starting a session](#starting-a-session)
> - [Documentation](#documentation)
> - [Development](#development-1)
> - [License](#license)

---

## How it works

Every message is encrypted with [XChaCha20-Poly1305](https://github.com/xero/covcom/wiki/CRYPTOGRAPHY#message-encryption). That is the core cipher.
Everything else exists to get a fresh, unique XChaCha20 key to the right
people at the right time.

Each participant owns one send chain: a stateful [`KDFChain`](https://github.com/xero/leviathan-crypto/wiki/ratchet#kdfchain) that steps
forward on every message via HKDF-SHA-256, producing a unique 32-byte key
and [wiping](https://github.com/xero/leviathan-crypto/wiki/utils#wipe) the previous chain key. Message keys are wiped after use.
Past keys are unrecoverable from current state.

Epoch transitions use [ML-KEM-768](https://github.com/xero/leviathan-crypto/wiki/mlkem) (FIPS 203). When a [ratchet fires](https://github.com/xero/covcom/wiki/PROTOCOL#the-ratchet), the
sender generates a shared seed, KEM-encapsulates it separately for each
peer, and [broadcasts the result](https://github.com/xero/covcom/wiki/CRYPTOGRAPHY#chain-seed-distribution). Every peer derives the same new chain from
that seed. The KEM ciphertext travels in-band; the decapsulator's keypair
rotates immediately after use.

The group uses a Sender Keys model: one send chain per participant, not one
per pair. O(N) state regardless of room size.

Every session mints a fresh [Ed25519](https://github.com/xero/leviathan-crypto/wiki/signaturesuite#ed25519-suites) signing keypair on construction. Every
identity claim and every broadcast is [signed](https://github.com/xero/leviathan-crypto/wiki/signing) under it, so each peer can
authenticate where a message came from.

Each peer's claims form a [BLAKE3](https://github.com/xero/leviathan-crypto/wiki/blake3#blake3)-chained log: every claim binds the previous
payload's hash. The server cannot reorder, drop, or substitute a structural
event mid-session without breaking the chain.

The signing public key derives a [fingerprint](https://github.com/xero/covcom/wiki/CRYPTOGRAPHY#fingerprint-derivation) for out-of-band verification:
`BLAKE3(sessionPk, 16)` rendered as eight OKLCh swatches and a 16-char hex
string. Compare it with your peers over a trusted channel to rule out a
machine-in-the-middle.

This implements the [Sparse Post-Quantum Ratchet](https://signal.org/docs/specifications/doubleratchet/#the-sparse-post-quantum-ratchet) from Signal's Double Ratchet spec (§5, Revision 4). For more detail, see [PROTOCOL.md](./docs/PROTOCOL.md).

Cryptographic primitives are provided by [leviathan-crypto](https://github.com/xero/leviathan-crypto).

## Quickstart

Point `chat.example.com` at the host you'll run on, then:

```sh
docker pull xerostyle/covcom:latest
docker run -d \
  -p 80:80 -p 443:443 \
  -e DOMAIN=chat.example.com \
  xerostyle/covcom:latest
```

Open https://chat.example.com in a browser. Create a room, share the invite, & chat.

---

## Requirements

- [Bun](https://bun.sh) v1.1 or later
- [Docker](https://docker.com) for the containerized server
- A modern browser (Chrome, Firefox, or Safari) for the web client

---

## Installation

```sh
git clone https://github.com/xero/covcom
cd covcom
bun i
```

---

## Server

### Docker

The Docker image runs the Bun WebSocket server behind Caddy with automatic
TLS via ACME. There are no build arguments; all configuration is runtime
environment variables.

**Pull and run from a registry:**

```sh
docker pull xerostyle/covcom:latest
docker run -d \
  -p 80:80 -p 443:443 \
  -e DOMAIN=chat.example.com \
  -v covcom_caddy_data:/data \
  -v covcom_caddy_config:/config \
  xerostyle/covcom:latest
```

The `covcom_caddy_data` volume persists Caddy's TLS certificate and ACME
account across restarts. Without it, Caddy re-provisions on every start and
will hit Let's Encrypt rate limits.

Published to [Docker Hub](https://hub.docker.com/r/xerostyle/covcom) as
`xerostyle/covcom` and [GHCR](https://github.com/xero/covcom/pkgs/container/covcom)
as `ghcr.io/xero/covcom`. Pin a specific version (e.g. `:3.0.0`) in production
so a vulnerability disclosure does not silently upgrade you. See
[USAGE.md](./docs/USAGE.md#docker) for tag conventions and how to extend the
image.

**Build locally:**

```sh
bun build:docker
```

This always builds clean (`--no-cache`), so a rebuild never serves a stale web
client out of a cached image layer.

**Run locally:**

`DOMAIN` is required; the container exits immediately without it. Pass it
inline, or put it in `docker/.env` (copy `docker/.env.example`), which
`docker/run` loads automatically.

```sh
DOMAIN=chat.example.com bun run:docker
```

Caddy provisions a TLS certificate for `$DOMAIN` on first start and stores it
on the mounted `covcom_caddy_data` volume, so it survives restarts. The
container listens on ports 80 and 443.

**Stop:**

```sh
docker compose -f docker/docker-compose.yml down
```

**Logs:**

```sh
docker compose -f docker/docker-compose.yml logs -f
```

### Docker (raw)

The same `bun build:docker` and `bun run:docker` commands work without
`docker compose`. When compose is absent, `docker/run` falls back to plain
`docker build` and `docker run` automatically. There is no separate command
to learn.

```sh
bun build:docker
DOMAIN=chat.example.com bun run:docker
```

On the fallback path, `docker/run` builds a local `covcom` image and runs it
directly, forwarding `DOMAIN`, `PORT`, `ADMIN_TOKEN`, `ROOM_TTL`, and
`MAX_ROOM_SIZE` from the environment or `docker/.env`, and mounting the
`covcom_caddy_data` and `covcom_caddy_config` volumes so Caddy's certificate
survives restarts.

### Production (no docker)

Runs the server directly via Bun without TLS or Caddy. Use this when
fronting COVCOM with your own reverse proxy.

```sh
bun start:server
```

This invokes `bun run src/index.ts` in the `server/` workspace and listens
on `localhost:$PORT` (default `1337`).

### Development

Runs the server in watch mode, useful for local testing where clients
connect over `ws://`.

```sh
bun dev:server
```

The server starts on `localhost:1337` and reloads on source changes.

### Environment Variables

| Variable        | Default  | Description                                                           |
| --------------- | -------- | --------------------------------------------------------------------- |
| `DOMAIN`        | required | Domain name for Caddy TLS                                             |
| `PORT`          | `1337`   | Internal port the Bun server listens on                               |
| `ADMIN_TOKEN`   | unset    | Optional token required to create rooms                               |
| `ROOM_TTL`      | `24`     | Hours of inactivity before an empty room is deleted. `0` disables TTL |
| `MAX_ROOM_SIZE` | `20`     | Maximum participants per room. `0` is unlimited                       |

`ADMIN_TOKEN` gates room _creation_ only. Joining is gated by the
`roomSecret` embedded in the invite, which the server generates at creation
time. You do not need `ADMIN_TOKEN` set to run a private server; the
`roomSecret` alone prevents uninvited joins.

---

## Web Client

**Development:**

```sh
bun dev:web
```

Open `http://localhost:5173`.

**Static build:**

```sh
bun build:web
```

Produces `web/dist/`: a single inlined `index.html`, no sidecar files. All
crypto, including chunked encrypted file transfer, runs as WASM on the main
thread, so the policy is the strictest possible, `default-src 'none'`, and works
in Safari/WebKit under a strict CSP (see
[leviathan-crypto/docs/csp.md](https://github.com/xero/leviathan-crypto/blob/main/docs/csp.md)).
Serve the file from any static host with no build step, or let
`bun build:docker` bake it into the image.

**Preview the production build:**

```sh
bun run --cwd web preview
```

Serves the contents of `web/dist/` locally for smoke-testing the bundled
output.

The interface mirrors the CLI: a chat pane plus the **Verify** and
**Event Log** sidebars. **Verify** lists your fingerprint and every peer's
side by side; **Event Log** records every inbound and outbound WebSocket
frame and crypto action, with redacted payloads and expandable detail rows.
Drag the divider between the chat and sidebar to resize, or double-click it
to reset. The eye button in the header hides or shows system messages
(joins, leaves, ratchets). Drag a file anywhere onto an open chat to send
it; drop a `.room` file on the lobby to load an invite. Press `Esc` in the
message box to open the keys-display (`R` ratchet, `E` events, `V` verify,
`Esc` return); the `/ratchet`, `/events`, and `/verify` commands work too.

---

## CLI client

The CLI is a compiled Bun binary with a custom zero-dependency TUI.

**Run from source:**

```sh
bun dev:cli
```

**Join directly from a `.room` file:**

```sh
bun dev:cli --join /path/to/invite.room
```

Two paranoia level flags are exposed which effect how the config file is used:

**Run without touching the config file** (no read, no save):

```sh
bun dev:cli --clean
```

`--clean` ignores `~/.config/covcom/config.json` entirely: no saved server or
username is prefilled, and nothing is written back. Combine with `--join` for a
fully ephemeral session, e.g. `bun dev:cli --clean --join /path/to/invite.room`.

**Run without exposing your saved identity:**

```sh
bun dev:cli --anon
```

`--anon` is a narrower `--clean`: it skips only the saved server and username.
they are not prefilled and not written, and the on-disk values are left
untouched, while theme, copy command, sidebar width, and icons still load and
persist as usual.

**Build a standalone binary for the current platform:**

```sh
bun build:cli
```

The binary lands in `cli/dist/`.

**Build for a specific target:**

```sh
bun run --cwd cli build:mac-arm # macOS Apple Silicon → cli/dist/covcom-macos-arm64
bun run --cwd cli build:mac-x64 # macOS Intel         → cli/dist/covcom-macos-x64
bun run --cwd cli build:linux   # Linux x86_64        → cli/dist/covcom-linux-x64
bun run --cwd cli build:win     # Windows x86_64      → cli/dist/covcom-win-x64.exe
```

**Build all platforms at once:**

```sh
bun build:cli:all
```

### Configuration

Settings save to `~/.config/covcom/config.json` after a successful connection.
The file is optional

```json
{
  "server": "chat.example.com",
  "username": "xero",
  "copyCmd": "xsel -b",
  "showSystem": true,
  "sidebar": { "width": 30 },
  "icons": { "send": ">", "attach": "+", "ratchet": "R" },
  "theme": {
    "btnFocusBg": { "type": "256", "n": 33 },
    "yourMsg":    { "type": "hex", "value": "#ff8800" }
  }
}
```

`copyCmd` sets the clipboard binary used on the lobby screen. If unset, the
CLI probes for `pbcopy`, `xclip`, `xsel`, and `wl-copy` in that order.

`showSystem` toggles whether system messages (peer joins, leaves, and ratchet
events) appear in the transcript. It defaults to `true`.

`theme` accepts any subset of the theme type. Each slot takes one of:
`{ "type": "ansi16", "n": 0-15 }`, `{ "type": "256", "n": 0-255 }`, or
`{ "type": "hex", "value": "#rrggbb" }`.

`sidebar.width` is the sidebar width as a percent (clamped 10-70). `icons`
overrides the glyphs for the bar buttons (`send`, `attach`, `ratchet`), the
in-chat `keys` rotated notice, and the keys-display units (`events`, `verify`,
`escape`); any unset entry falls back to its default or renders nothing.

> [!TIP]
> The full list of config settings and color theme names are defined in the [CLI-SPEC](https://github.com/xero/covcom/wiki/CLI-SPEC#defaults)

### Navigation

| Key                 | Action                                |
|---------------------|---------------------------------------|
| `Tab` / `Shift+Tab` | Cycle focus                           |
| `Enter`             | Send message / confirm                |
| `Ctrl+C`            | Confirm-quit prompt; press again to quit and wipe session |
| `Esc` (in input)    | Open the keys-display over the input bar |

Ratchet, the event log, and verify are reached from the keys-display: press
`Esc` while the message input is focused and the input bar becomes a row of `R`
ratchet / `E` events / `V` verify / `Esc` return units. Press the key (shift
does not matter); the action runs and the display closes back to the input.
`Esc` returns without doing anything. The `/ratchet`, `/events`, and `/verify`
commands do the same.

When the sidebar has focus, `↑/↓` move selection in the event log, `PgUp/PgDn`
page through, `Enter` expands the selected entry's details, and `+`/`-` step
the sidebar width by 5%. `Esc` closes the sidebar.

**Slash commands.** Anything you type that starts with `/` is a command;
everything else is sent as a message. `/help` (or `/?`) lists them.

| Command                         | Action                                  |
|---------------------------------|-----------------------------------------|
| `/help`, `/?`                   | Show the command list                   |
| `/exit`, `/quit`, `/q`, `/part` | Quit and wipe the session               |
| `/ratchet`                      | Rotate keys                             |
| `/events`                       | Toggle the event-log sidebar            |
| `/verify`                       | Toggle the verify sidebar               |

An unrecognized command prints `unknown command: <name>. type /help for a list`.

Files attach via the `+` button. Type or paste a path and use `Tab` for
completion. Received files save to the current working directory; existing
filenames get a numeric suffix.

---

## Starting a session

**Create a room:**

1. Enter a server address and a username, then select **Create Room**.
2. The lobby screen shows an armored invite block, a QR code of the same
   bytes, and copy/download buttons. Share it via any channel.
3. The screen waits until a peer joins.

Sample armored invite:
```
-----BEGIN COVCOM INVITE-----
AWU5YTYyMWVhMzQwOTM2MDRkMTM5M2MxNTQ0ZDBjNjg0gCIiZMnOHFyPCn5zIfaLsGNvdmNvbS4zeGkuY2x1Yg==
-----END COVCOM INVITE-----
```

**Join a room:**

1. Enter a username and select **Join Room**.
2. Paste the armored invite text, drag-drop the `.room` file (web), or
   provide the file path (CLI).
3. Select **Connect**.

Once both sides complete the handshake, the chat opens. The server has relayed
a sequence of encrypted blobs and learned nothing about the content.

Clients and the server negotiate a wire-protocol version at create and join
time. If they disagree, the server refuses the connection up front and reports
its own version, so a mismatched client sees "This server is running a
different version" instead of a cryptic handshake failure. This is a
compatibility gate, not a security boundary.

Late joiners receive current epoch seeds from all present members and enter
the session at whatever epoch each sender is at. Messages sent before you
joined are not recoverable. This is forward secrecy working as intended.

The connection survives drops. On network loss the client shows "connection
lost; reconnecting…" and retries with exponential backoff, then shows
"connection restored" once it reconnects; the chat stays mounted the whole
time. Peers joining, leaving, and reconnecting appear as system messages. A
peer who reconnects with a changed fingerprint is flagged "reconnected (fp
changed)" so you can re-verify them. A join past `MAX_ROOM_SIZE` is refused
with "Room is full", and empty rooms are pruned after `ROOM_TTL` hours.

---

## Documentation

Deeper references for users, auditors, contributors, and the curious.

| Document                                              | Purpose                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| [USAGE](./docs/USAGE.md)                              | Client and server applications development and runtime help           |
| [PROTOCOL](./docs/PROTOCOL.md)                        | Cipher, chains, ratchet, group model, session lifecycle, server role  |
| [CRYPTOGRAPHY](./docs/CRYPTOGRAPHY.md)                | Primitives, KDF chains, wire format, invite encoding                  |
| [THREAT-MODEL](./docs/THREAT-MODEL.md)                | Principals, adversary tiers, guarantees, non-goals                    |
| [CLI-SPEC](./docs/CLI-SPEC.md)                        | CLI architecture, rendering, input, widgets, views, & color system    |
| [TESTING](./docs/TESTING.md)                          | Test layers, unit and end-to-end suites, cross-client interop, and CI   |
| [SECURITY-POLICY](./SECURITY.md)                      | Supported versions, disclosure policy, cryptographic foundation       |
| [DIAGRAM](https://xero.github.io/covcom/diagram.html) | Animated and annotated visualization of a complete three peer session |

> [!TIP]
> Documentation is available in the repo `./docs` folder and published to the project [wiki](https://github.com/xero/covcom/wiki).

---

## Development

**Run the full test suite:**

```sh
bun run test
```

This runs `test:server`, `test:lib`, `test:web`, `test:cli`, and the
Playwright `test:e2e` suite in sequence, each via `bun run`. Note the
`bun run` prefix: a bare `bun test` invokes Bun's built-in runner with the
script name treated as a path filter, not the package script. The e2e run
needs Chromium installed once (see below).

**Run tests for a single package:**

```sh
bun run test:server  # server WebSocket broker
bun run test:lib     # shared crypto session layer
bun run test:web     # web client (store, session, bridge, views) via happy-dom
bun run test:cli     # CLI widgets, key parsing, state machine, event log
```

**Run the end-to-end test on its own (Playwright):**

```sh
bunx playwright install --with-deps chromium firefox webkit  # one time
bun run test:e2e
```

`test:e2e` auto-starts the Bun broker and the Vite dev server, then drives real
browser contexts through the full flow: a two-party encrypted chat (create →
invite → join → exchange messages → verify fingerprints) plus the file-attachment
round-trip and stress sweeps, which push encrypted attachments up to 180 MiB
through chunked streaming.

**Lint:**

```sh
bun lint  # report issues
bun fix   # report and autofix
```

**Typecheck:**

```sh
bun typecheck
```

This runs `tsc --noEmit` across every workspace (root, lib, server, web, and
cli). `bun build:web` compiles with esbuild and does not typecheck, so run
this separately.

**Build all release artifacts:**

```sh
bun bake
```

Builds the inlined web bundle and every CLI binary (`build:web`,
`bundle:cli`, then `build:cli:all`).

**Full pre-release check:**

```sh
bun check
```

Runs `lint`, `typecheck`, `bake`, and the full test suite in one pass. This
is the single gate to validate a release candidate.

**Repository layout:**

```
server/    WebSocket broker (Bun)
lib/       Shared crypto session layer
web/       Vite + vanilla TS web client
cli/       Custom zero-dependency TUI
docker/    Dockerfile, Caddyfile template, entrypoint
docs/      Project documentation / Wiki sources
```

## License

**COVCOM** is released under the [MIT license](./LICENSE).
