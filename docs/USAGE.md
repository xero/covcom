```
  ▄██▀ ▀█  ▄██▀ █▄  ▀██  ██▀  ▄██▀ ▀█  ▄██▀ █▄   █▄   ▄█
 ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒  ▒▒  ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒▒▄▒▒▒
 ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒▌ ▒▒  ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒ ▀ ▒▒
  ▀██▄ ▄█  ▀██▄ █▀    ▀█▄▀    ▀██▄ ▄█  ▀██▄ █▀  ▄██▄ ▄██▄

XChaCha20 · ML-KEM-768 · Ed25519 · BLAKE3 · SPQR · E2EE · ephemeral · N-party
```

# COVCOM Usage Reference

> ### Table of Contents
> - [how it works](#how-it-works)
> - [requirements](#requirements)
> - [installation](#installation)
> - [server](#server)
>   - [docker](#docker)
>   - [docker (raw)](#docker-raw)
>   - [production (no docker)](#production-no-docker)
>   - [development](#development)
>   - [environment variables](#environment-variables)
> - [web client](#web-client)
> - [cli client](#cli-client)
>   - [configuration](#configuration)
>   - [navigation](#navigation)
> - [starting a session](#starting-a-session)
> - [formatting messages](#formatting-messages)
> - [development](#development-1)

---

## how it works

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

This implements the [Sparse Post-Quantum Ratchet](https://signal.org/docs/specifications/doubleratchet/#the-sparse-post-quantum-ratchet) from Signal's Double Ratchet spec (§5, Revision 4). For more detail, see [PROTOCOL.md](./PROTOCOL.md).

Cryptographic primitives are provided by [leviathan-crypto](https://github.com/xero/leviathan-crypto).

---

## requirements

- [Bun](https://bun.sh) v1.1 or later
- [Docker](https://docker.com) for the containerized server
- A modern browser (Chrome, Firefox, or Safari) for the web client

---

## installation

```sh
git clone https://github.com/xero/covcom
cd covcom
bun i
```

---

## server

### docker

The Docker image runs the Bun WebSocket server behind Caddy with automatic
TLS via ACME. There are no build arguments; all configuration is runtime
environment variables.

The image is published to two registries on every release:

- **Docker Hub:** [`xerostyle/covcom`](https://hub.docker.com/r/xerostyle/covcom)
- **GHCR:** [`ghcr.io/xero/covcom`](https://github.com/xero/covcom/pkgs/container/covcom)

Two tags are published per release:

- `X.Y.Z` is the pinned semantic version. Use this in production.
- `latest` moves with each release. A new release will silently upgrade you on the next pull.

If a vulnerability is disclosed, the affected `X.Y.Z` tag is hard-deprecated
via a tombstone wrapper: pulling it then exits nonzero with an error message
pointing at the safe replacement. Pinning a specific version means you find
out immediately. See [SECURITY.md](../SECURITY.md) for the full disclosure
and deprecation policy.

**Pull and run:**

```sh
docker pull xerostyle/covcom:latest
docker run -d \
  -p 80:80 -p 443:443 \
  -e DOMAIN=chat.example.com \
  -v covcom_caddy_data:/data \
  -v covcom_caddy_config:/config \
  xerostyle/covcom:latest
```

The volume mounts persist Caddy's TLS certificates and config across container
restarts. Without them, Caddy re-provisions a certificate on every start, which
will hit Let's Encrypt rate limits, or break SSL pinning if used.

**Extend the image:**

The published image is a sensible base for layering your own Caddy config,
extra binaries, or sidecar tooling. Pin to a specific version so your custom
image does not drift on every COVCOM release.

```Dockerfile
FROM ghcr.io/xero/covcom:1.0.0

# example: drop in additional Caddy directives
COPY my-caddy-extras.conf /etc/caddy/extras.conf

# example: add a sidecar utility (base image is debian-based)
RUN apt-get update && apt-get install -y --no-install-recommends \
      dnsutils \
    && rm -rf /var/lib/apt/lists/*
```

The base image's entrypoint and exposed ports (80, 443) remain in effect
unless you override them. The same environment variables documented in
[environment variables](#environment-variables) below apply to your derived
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

### docker (raw)

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

### production (no docker)

Runs the server directly via Bun without TLS or Caddy. Use this when
fronting COVCOM with your own reverse proxy.

```sh
bun start:server
```

This invokes `bun run src/index.ts` in the `server/` workspace and listens
on `localhost:$PORT` (default `3000`).

### development

Runs the server in watch mode, useful for local testing where clients
connect over `ws://`.

```sh
bun dev:server
```

The server starts on `localhost:3000` and reloads on source changes.

### environment variables

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

## web client

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
strict-CSP friendly, `worker-src 'self'` with no `blob:`, so file transfer
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

## cli client

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

### configuration

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

### navigation

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
the sidebar width by 5%. `Esc` closes the sidebar. The sidebar is auto-hidden
on terminals narrower than 80 columns.

Files attach via the `+` button. Type or paste a path and use `Tab` for
completion. Received files save to the current working directory; existing
filenames get a numeric suffix.

---

## starting a session

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

## formatting messages

Both clients render a small markdown subset in message bodies. The web client
draws it as styled DOM; the CLI draws it with terminal colors and bold/italic.

- **Bold.** Wrap text in `*asterisks*`.

- **Italic.** Wrap text in `_underscores_`.

- **Bold and italic.** Combine the markers as `_*both*_` or `*_both_*`.

- **Inline code.** Wrap text in `` `backticks` ``. The contents render
  verbatim, so markers inside code stay literal.

- **Code block.** Fence a span of lines with ` ``` ` on their own lines. The
  block preserves whitespace and newlines.

Formatting is applied at display time only. The wire still carries your exact
plaintext, and the markers travel with it as ordinary characters. Untrusted
text from peers is sanitized before rendering, so a crafted message cannot
inject HTML in the browser or escape sequences in the terminal.

---

## development

**Run all tests:**

```sh
bun test
```

This runs `test:server`, `test:lib`, and the `test:cli` stub in sequence.
The `web/` workspace has no unit tests (browser app).

**Run tests for a single package:**

```sh
bun test:server     # server WebSocket broker
bun test:lib        # shared crypto session layer
```

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
docs/      Project documentation
```
