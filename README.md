# COVCOM

**COVCOM**: covert communications for private group conversations. Share an
invite, talk, close the tab, and it's gone. End-to-end encrypted with
post-quantum cryptography, so the messages stay private today and unreadable to
the computers coming tomorrow.

`XChaCha20 · ML-KEM-768 · SPQR · E2EE · ephemeral · N-party`

> ### Table of Contents
> - [how it works](#how-it-works)
> - [requirements](#requirements)
> - [installation](#installation)
> - [server](#server)
>   - [docker](#docker)
>   - [development](#development)
>   - [environment variables](#environment-variables)
> - [web client](#web-client)
> - [cli client](#cli-client)
>   - [configuration](#configuration)
>   - [navigation](#navigation)
> - [starting a session](#starting-a-session)
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

This implements the [Sparse Post-Quantum Ratchet](https://signal.org/docs/specifications/doubleratchet/#the-sparse-post-quantum-ratchet)
from Signal's Double Ratchet spec (§5, Revision 4). For more detail, see
[PROTOCOL.md](./PROTOCOL.md).

Cryptographic primitives are provided by
[leviathan-crypto](https://github.com/xero/leviathan-crypto).

---

## requirements

- [Bun](https://bun.sh) v1.1 or later
- [Docker](https://docker.com) for the containerized server
- A modern browser (Chrome, Firefox, or Safari) for the web client

---

## installation

```sh
git clone https://github.com/xero/leviathan-messenger
cd leviathan-messenger
bun i
```

---

## server

### docker

The Docker image runs the Bun WebSocket server behind Caddy with automatic
TLS via ACME. There are no build arguments; all configuration is runtime
environment variables.

**Build:**

```sh
bun docker:build
```

**Run:**

```sh
DOMAIN=chat.example.com bun docker:run
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

### development

Runs the server directly without Docker or TLS, useful for local testing
where clients connect over `ws://`.

```sh
bun dev:server
```

The server starts on `localhost:3000`.

### environment variables

| Variable | Default | Description |
|---|---|---|
| `DOMAIN` | required | Domain name for Caddy TLS |
| `PORT` | `3000` | Internal port the Bun server listens on |
| `ADMIN_TOKEN` | unset | Optional token required to create rooms |
| `ROOM_TTL` | `24` | Hours of inactivity before an empty room is deleted. `0` disables TTL |
| `MAX_ROOM_SIZE` | `20` | Maximum participants per room. `0` is unlimited |

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

Output goes to `web/dist/`. Serve it from any static file host or include it
in the Docker image via `bun build:web:container` before building.

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

**Build a standalone binary:**

```sh
bun build:cli
```

### configuration

Settings save to `~/.config/leviathan-messenger/config.json` after a
successful connection. The file is optional; all fields can be set
interactively.

```json
{
  "server": "chat.example.com",
  "username": "xero",
  "copyCmd": "xsel -b",
  "systemMessages": true,
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
| `Ctrl+C`            | Quit and wipe session                 |

Files attach via the `+` button. Type or paste a path and use `Tab` for
completion. Received files save to the current working directory; existing
filenames get a numeric suffix.

---

## starting a session

**Create a room:**

1. Enter a server address and a username, then select **Create Room**.
2. The lobby screen shows an armored invite block. Copy or download it and
   share it via any channel.
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

## development

**Run all tests:**

```sh
bun test
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
