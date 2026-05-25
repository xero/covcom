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

Every message is encrypted with XChaCha20-Poly1305. That is the core cipher.
Everything else exists to get a fresh, unique XChaCha20 key to the right
people at the right time.

Each participant owns one send chain: a stateful `KDFChain` that steps
forward on every message via HKDF-SHA-256, producing a unique 32-byte key
and wiping the previous chain key. Message keys are wiped after use.
Past keys are unrecoverable from current state.

Epoch transitions use ML-KEM-768 (FIPS 203). When a ratchet fires, the
sender generates a shared seed, KEM-encapsulates it separately for each
peer, and broadcasts the result. Every peer derives the same new chain from
that seed. The KEM ciphertext travels in-band; the decapsulator's keypair
rotates immediately after use.

The group uses a Sender Keys model: one send chain per participant, not one
per pair. O(N) state regardless of room size.

Every session also mints a fresh Ed25519 signing keypair on construction.
Identity claims and every broadcast are signed under it. Each peer's
claims form a BLAKE3-chained log: every claim binds the previous payload's
hash, so the server cannot reorder, drop, or substitute a structural event
mid-session without breaking the chain. The session signing public key
derives a fingerprint surface (`BLAKE3(sessionPk, 16)` → eight OKLCh
swatches + 16-char hex) for out-of-band verification. Both clients expose
a sidebar with two panels: **Verify** lists your fingerprint and every
peer's side-by-side; **Event Log** captures every inbound/outbound
WebSocket frame and every crypto action with redacted payloads and
expandable detail rows.

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
  xerostyle/covcom:latest
```

Published to [Docker Hub](https://hub.docker.com/r/xerostyle/covcom) as
`xerostyle/covcom` and [GHCR](https://github.com/xero/covcom/pkgs/container/covcom)
as `ghcr.io/xero/covcom`. Pin a specific version (e.g. `:1.0.0`) in production
so a vulnerability disclosure does not silently upgrade you. See
[USAGE.md](./docs/USAGE.md#docker) for tag conventions and how to extend the
image.

**Build locally:**

```sh
bun build:docker
```

**Run locally:**

```sh
DOMAIN=chat.example.com bun run:docker
```

Caddy provisions a TLS certificate for `$DOMAIN` on first start. The
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

For environments without `docker compose`. The compose file is the
recommended path; these are escape hatches.

**Build:**

```sh
bun build:docker:raw
```

**Run:**

```sh
DOMAIN=chat.example.com bun run:docker:raw
```

The raw run forwards `DOMAIN`, `PORT`, `ADMIN_TOKEN`, and `MAX_ROOM_SIZE`
from the environment and mounts named volumes for Caddy data and config.

### Production (no docker)

Runs the server directly via Bun without TLS or Caddy. Use this when
fronting COVCOM with your own reverse proxy.

```sh
bun start:server
```

This invokes `bun run src/index.ts` in the `server/` workspace and listens
on `localhost:$PORT` (default `3000`).

### Development

Runs the server in watch mode, useful for local testing where clients
connect over `ws://`.

```sh
bun dev:server
```

The server starts on `localhost:3000` and reloads on source changes.

### Environment Variables

| Variable        | Default  | Description                                                           |
| --------------- | -------- | --------------------------------------------------------------------- |
| `DOMAIN`        | required | Domain name for Caddy TLS                                             |
| `PORT`          | `3000`   | Internal port the Bun server listens on                               |
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

Produces `web/dist/`: an inlined `index.html` plus a same-origin pool worker
(`covcom-pool-worker.js`) used for encrypted file transfer. The policy is
strict-CSP friendly — `worker-src 'self'` with no `blob:`, so file transfer
works in Safari/WebKit under a strict CSP (see
[leviathan-crypto/docs/csp.md](https://github.com/xero/leviathan-crypto/blob/main/docs/csp.md)).
Serve the directory from any static file host with no build step, or let
`bun build:docker` bake it into the image.

**Preview the production build:**

```sh
bun run --cwd web preview
```

Serves the contents of `web/dist/` locally for smoke-testing the bundled
output.

---

## CLI client

The CLI is a compiled Bun binary with a custom zero-dependency TUI.

**Run from source:**

```sh
bun dev:cli
```

**Join directly from a `.room` file:**

```sh
bun dev:cli join /path/to/invite.room
```

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

Settings save to `~/.config/covcom/config.json` after a
successful connection. The file is optional; all fields can be set
interactively.

```json
{
  "server": "chat.example.com",
  "username": "xero",
  "copyCmd": "xsel -b",
  "showSystem": true,
  "theme": {
    "btnFocusBg": { "type": "256", "n": 33 },
    "yourName":   { "type": "hex", "value": "#ff8800" }
  }
}
```

`copyCmd` sets the clipboard binary used on the lobby screen. If unset, the
CLI probes for `pbcopy`, `xclip`, `xsel`, and `wl-copy` in that order.

`theme` accepts any subset of the theme type. Each slot takes one of:
`{ "type": "ansi16", "n": 0-15 }`, `{ "type": "256", "n": 0-255 }`, or
`{ "type": "hex", "value": "#rrggbb" }`.

### Navigation

| Key                 | Action                                |
|---------------------|---------------------------------------|
| `Tab` / `Shift+Tab` | Cycle focus                           |
| `Enter`             | Send message / confirm                |
| `Ctrl+R`            | Rotate encryption keys (ratchet step) |
| `Ctrl+E`            | Toggle event-log sidebar              |
| `Ctrl+V`            | Toggle fingerprint-verify sidebar     |
| `Ctrl+C`            | Quit and wipe session                 |

When the sidebar has focus, `↑/↓` move selection in the event log, `PgUp/PgDn`
page through, `Enter` expands the selected entry's details, and `+`/`-` step
the sidebar width by 5%. `Esc` closes the sidebar.

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

**Join a room:**

1. Enter a username and select **Join Room**.
2. Paste the armored invite text, drag-drop the `.room` file (web), or
   provide the file path (CLI).
3. Select **Connect**.

Once both sides complete the handshake, the chat opens. The server has relayed
a sequence of encrypted blobs and learned nothing about the content.

Late joiners receive current epoch seeds from all present members and enter
the session at whatever epoch each sender is at. Messages sent before you
joined are not recoverable. This is forward secrecy working as intended.

---

## Documentation

Deeper references for users, auditors, contributors, and the curious.

| Document                                                                  | Purpose                                                              |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [USAGE](./docs/USAGE.md)                                                  | Client and server applications development and runtime help          |
| [PROTOCOL](./docs/PROTOCOL.md)                                            | Cipher, chains, ratchet, group model, session lifecycle, server role |
| [CRYPTOGRAPHY](./docs/CRYPTOGRAPHY.md)                                    | Primitives, KDF chains, wire format, invite encoding                 |
| [THREAT-MODEL](./docs/THREAT-MODEL.md)                                    | Principals, adversary tiers, guarantees, non-goals                   |
| [CLI-SPEC](./docs/CLI-SPEC.md)                                            | CLI architecture, rendering, input, widgets, views, & color system   |
| [SECURITY-POLICY](./SECURITY.md)                                          | Supported versions, disclosure policy, cryptographic foundation      |
| [PROTOCOL-DIAGRAM](https://xero.github.io/covcom/protocol_diagram.html)   | Animated visualization of a 3-party session and epochs               |
| [RECONNECT-DIAGRAM](https://xero.github.io/covcom/reconnect_diagram.html) | Animated visualization of peers left / join ceremonies               |

> [!TIP]
> Documentation is available in the repo `./docs` folder and published to the project [wiki](https://github.com/xero/covcom/wiki).

---

## Development

**Run all unit tests:**

```sh
bun test
```

This runs `test:server`, `test:lib`, `test:web`, and the `test:cli` stub in
sequence (all via `bun test`). The `cli/` TUI has no unit tests.

**Run tests for a single package:**

```sh
bun test:server     # server WebSocket broker
bun test:lib        # shared crypto session layer
bun test:web        # web client (store, session, bridge, views) via happy-dom
```

**Run the end-to-end test (Playwright):**

```sh
bunx playwright install chromium   # one time
bun test:e2e
```

`test:e2e` auto-starts the Bun broker and the Vite dev server, then drives two
browser contexts through a real two-party encrypted chat (create → invite →
join → exchange messages → verify fingerprints). It is not part of `bun test`
because it needs running servers and a browser.

**Lint and autofix:**

```sh
bun fix
```

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
