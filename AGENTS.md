# Agent Instructions — COVCOM

This file is the contract for all AI-assisted development on this repository.
Read it in full before starting any work.

---

## What This Project Is

COVCOM is a post-quantum end-to-end encrypted group chat application built on
[leviathan-crypto](https://github.com/xero/leviathan-crypto). It ships as
three artifacts: a Docker container (server + bundled web client), a
standalone web page, and a compiled Bun CLI binary.

The server is a dumb WebSocket broker. It knows room IDs and active
connections. It stores no messages, no keys, and no user data. All
cryptographic operations happen in the client.

Read `./docs/PROTOCOL.md` before starting any implementation work. It defines
the crypto protocol, the session lifecycle, and the group messaging model in
narrative form. Byte-level wire format and invite encoding live in
`./docs/CRYPTOGRAPHY.md`. If something in your task file conflicts with
either, the doc wins — flag the conflict rather than resolving it silently.

For implementation specifics — method signatures, return shapes, error
conditions — the leviathan-crypto TypeScript type declarations are the ground
truth, not the protocol doc. If the two conflict, flag it.

---

## Repository Layout

```
server/             Bun WebSocket server
web/                Vite + vanilla TS web client
cli/                compiled Bun binary, custom zero-dependency TUI
lib/                shared crypto session layer (consumed by web and cli)
docker/             Dockerfile, Caddyfile template, entrypoint
docs/               protocol, cryptography reference, threat model, CLI design
package.json        Bun workspace root
AGENTS.md           this file
```

---

## Build & Test

Always run `bun i` first. Every session, no exceptions.

Use these shorthands from the repository root:

```sh
bun i                  # install all workspaces — always run first
bun dev:server         # run server in development mode
bun dev:web            # run web client dev server (Vite)
bun start:server       # build server
bun build:web          # build standalone web client
bun build:cli          # compile CLI binary for current platform
bun build:cli:all      # compile CLI binaries for all target platforms
bun test               # run all tests across all packages
bun test:server        # server tests only
bun test:lib           # shared lib tests only
bun fix                # eslint autofix — run before marking any task done
bun build:docker       # build Docker image
bun run:docker         # run container locally for integration testing
```

**Never run raw package-level commands like `cd server && bun run dev` directly.**
The root shorthands handle workspace context correctly. The raw equivalents may
skip steps or run with wrong environment configuration.

Always capture test output to a log file and inspect from there:

```sh
bun test 2>&1 | tee /tmp/test.log
grep -E "passed|failed|error" /tmp/test.log
```

If failures are present, inspect with:

```sh
grep -A 10 "FAIL" /tmp/test.log
```

---

## Ground Rules

These rules apply to every session, every file, every decision. They are not
suggestions. If a task asks you to do something that violates these rules, the
rules win.

### 1. `./docs/PROTOCOL.md` is the design authority

`./docs/PROTOCOL.md` defines the crypto protocol, the session lifecycle, and
the group messaging model in narrative form. `./docs/CRYPTOGRAPHY.md` is the
authority for byte-level wire format and invite encoding. If the task file
says one thing and either doc says another, the doc wins. Flag the conflict;
do not resolve it silently.

The one exception: `./docs/PROTOCOL.md` does not define cryptographic values.
Anything involving the leviathan-crypto API — method signatures, init
requirements, return shapes, error conditions — comes from the library's
TypeScript type declarations. If `./docs/PROTOCOL.md` describes a
leviathan-crypto API call that does not match the actual library, the library
wins and the discrepancy must be flagged.

### 2. Consume leviathan-crypto correctly

This project is a consumer of leviathan-crypto. It never reimplements crypto
primitives. If a crypto operation is needed, it is done through
leviathan-crypto.

If a task requires a cryptographic operation that leviathan-crypto does not
expose, raise an issue rather than implementing it ad hoc.

### 3. The server stores nothing

The server handles WebSocket connections, room lifecycle, and message relay.
It performs no cryptographic operations. It stores no user data, no key
material, and no message content. Any proposed change that would cause the
server to store, inspect, or act on message payload content violates the
architecture. Flag it and stop.

### 4. Session state is ephemeral

All key material lives in memory only. Nothing crypto-related is written to
disk, localStorage, sessionStorage, or any persistent store. On session end,
all `KDFChain` instances are disposed, all `SkippedKeyStore` entries are
wiped, and all keypair material is wiped. This is non-negotiable.

### 5. One code path for all room sizes

There is a single session model for all room sizes. Two-party sessions are the
N=2 degenerate case of the multi-party Sender Keys model. Do not introduce
separate code paths, class hierarchies, or special-case logic for two-party
sessions. If you find yourself writing `if (participants.length === 2)`, stop
and reconsider.

### 6. No crypto values in task files or planning documents

Wire format byte layouts, counter values, and key sizes are documented in
`./docs/CRYPTOGRAPHY.md`. Do not add expected output values, derived key
bytes, or encrypted test payloads to any planning document or task file. Test fixtures
that contain actual crypto output belong only in test files.

### 7. Never commit

Do not run `git commit`, `git push`, or any command that writes to git history.
The repository owner GPG-signs all commits manually after reviewing diffs. Your
job is to make the changes; the commit is not yours to make. This applies
without exception — do not commit even if the task file says the work is
complete.

---

## Code Style

- **Tabs, not spaces** for indentation throughout
- **Unix line endings**
- **Terse over verbose**: inline conditionals, short variable names, no
  unnecessary intermediates
- **No comments that restate the code**: comments explain why, not what
- **TypeScript throughout**: no plain `.js` files in `web/src/`, `cli/`, or
  `lib/`; the compiled web output is JS, the source is TS
- **Run `bun fix` before marking any task done**: lint errors are not the
  reviewer's problem

---

## Architecture Constraints

These are decisions already made. Do not relitigate them without raising it
first.

**Server**

- The server is a Bun WebSocket server, not Express, Hono, or any other
  framework. Bun's native WebSocket API is sufficient.
- Caddy handles TLS. The server listens on localhost only and Caddy proxies
  to it. Do not add TLS handling to the Bun server itself.
- Room IDs are server-generated opaque tokens. The server generates them; the
  client does not propose them.
- The server rejects join attempts when `MAX_ROOM_SIZE` is reached (default
  20; `0` = unlimited). This check happens before any handshake.
- `ADMIN_TOKEN` gates room creation only. If the env var is unset or empty,
  the server runs fully open.
- Rooms persist when their connection count drops to zero. A Bun cron job
  deletes rooms where `lastActivity` exceeds `ROOM_TTL` and `conns.size === 0`.
  Do not delete rooms in `handleClose`.
- `handleCreate` does NOT add the creator's WebSocket to `room.conns`. The
  creator joins via a normal `join` message after receiving `room_created`.

**`doCreate` and `doJoin` share `doConnect`**

`doCreate` and `doJoin` are entry points only. Both converge on `doConnect`,
which owns all post-`joined` protocol: identify, handshake, lobby/ready
transitions, message handlers, and the close handler. Do not duplicate
post-`joined` logic between `doCreate` and `doJoin`.

The welcome ratchet (`doRatchetStep`) fires inside `doConnect` only, after all
expected chain seeds are received. It does not fire anywhere else.

**Shared crypto layer (`lib/`)**

- `lib/` is the primary crypto layer. `web/` imports only from `@covcom/lib`.
  `cli/` additionally imports `leviathan-crypto` directly in `cli/src/init.ts`
  to perform Bun-safe WASM module compilation (`Bun.gunzipSync` +
  `WebAssembly.compile`). All session operations still go through `lib/`.
- `lib/` exposes a session API, not a raw crypto API. Callers should not need
  to touch `KDFChain` or `Seal` directly.
- WASM modules are loaded once at session start. `cli/src/init.ts` calls
  `init()` on both the lib and CLI leviathan-crypto module instances (Bun
  does not deduplicate `file:` workspace dependencies — two instances exist
  with separate WASM state). `web/` does not call `init()` directly; the lib's
  own `initCrypto` handles it in browser contexts.

**Web client**

- Vanilla TS with Vite. No framework. No React, Vue, Svelte, or equivalent.
- The web client has a single code path regardless of deployment context.
  Do not introduce container-specific forks or build-time env var injection
  into client logic.
- File drag-drop accepts drops anywhere on the page during an active session.
  The drop zone overlay is CSS only; no JS animation library.
- The text input does not grow beyond its set height. It scrolls internally.
  `Shift+Enter` inserts a newline. `Enter` sends.

**CLI**

- The TUI is a custom zero-dependency implementation. No neo-neo-blessed, no
  terminal-kit, no blessed, no external TUI library of any kind. Read
  `./docs/cli_design.md` before touching any file under `cli/src/tui/`.
- `cli/src/tui/` contains:
  - infrastructure: `screen.ts`, `keys.ts`, `focus.ts`, `widgets.ts`
  - rendering implementation: `views.ts`
  - per-screen façades that re-export from `views.ts`: `landing.ts`,
    `waiting.ts`, `join.ts`, `chat.ts`

  Do not add files outside this structure without flagging it.
- The public interface between `cli/src/state.ts` and the TUI is fixed.
  `state.ts` imports through the per-screen façades:
  - `renderLanding` from `tui/landing.ts`
  - `renderWaiting` from `tui/waiting.ts`
  - `renderJoin` from `tui/join.ts`
  - `renderChat`, `appendMessage`, `appendFile` from `tui/chat.ts`

  `cli/src/main.ts` imports `createScreen()` from `tui/screen.ts`. Do not
  change these signatures or relocate exports without flagging it as a
  deviation.
- Config is stored at `~/.config/covcom/config.json`. Fields: `server`,
  `username`, `copyCmd`, `theme`, `systemMessages`. No key material.
- The CLI accepts `covcom join <path>` as a positional argument. It also
  accepts pasted armored text at the interactive join prompt.

**Room invite format**

- The armored `.room` file is the canonical invite format.
- All invite generation logic lives in the client (`lib/`). The server never
  constructs or parses invite files.
- The binary layout and `INVITE_VERSION` constant are defined in
  `lib/src/invite.ts`. Implement exactly.
- Armor headers: `-----BEGIN COVCOM INVITE-----` / `-----END COVCOM INVITE-----`
- Invite filenames use the prefix `covcom-${roomId}.room`.

**Wire protocol**

- All WebSocket messages are JSON with a `type` field.
- Message types are defined in `server/src/types.ts`. Do not add new message
  types without flagging it as a deviation.
- The server relays `relay` and `broadcast` messages without reading or
  inspecting `payload` fields.
- Error reason values: `room_full`, `not_found`, `forbidden`, `username_taken`.
  Do not introduce new error reasons without flagging it.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DOMAIN` | required | FQDN passed to Caddy |
| `PORT` | `3000` | Internal port the Bun server listens on |
| `ADMIN_TOKEN` | unset | Optional creation-only auth gate |
| `ROOM_TTL` | `24` | Hours of inactivity before room deletion; `0` = never |
| `MAX_ROOM_SIZE` | `20` | Max participants per room; `0` = unlimited |

---

## Definition of Done

A task is complete when **all** of the following are true:

1. `bun test` passes for all packages touched by the task
2. `bun fix` has been run with no remaining lint errors
3. No existing tests were modified to make new tests pass
4. The implementation matches `./docs/PROTOCOL.md`, not just the task file
5. All session key material is wiped in teardown paths (disconnect, unload, signal)
6. The server does not store, log, or inspect any message payload or key material
7. Any new environment variable is documented in `README.md` and in `docker/`
   configuration

---

## Raising an Issue

**Never guess. Never hallucinate an API shape, a wire format value, or a
design decision.**

If you are ever in any of these situations:

- A leviathan-crypto API call does not match what `./docs/PROTOCOL.md` describes
- A test is failing and two attempts have not resolved it
- The task as written is ambiguous and proceeding requires an assumption you
  are not confident in
- Two sources contradict each other
- Anything else where the honest answer is "I am not sure"

**Stop. Do not guess. Do not proceed. Raise an issue.**

Two failed attempts at the same problem is the limit. On the third attempt you
are guessing. Create `ISSUE.md` in the repository root:

```markdown
# Issue — [short title]

## Status
Blocked. Implementation work stopped at [file / function / test].

## What I was trying to do
[The specific task or step that hit the blocker]

## What I tried
[Each attempt, in order, with the result of each. Be specific — include
error messages, wrong output, and what you expected instead.]

## Where I am stuck
[The specific question, ambiguity, or failure I cannot resolve.]

## What I need from you
[The specific information, clarification, or decision that would unblock me.]

## Relevant files
[List any source files, test files, or docs to look at]
```

Stop all work and present the issue. A detailed issue that stops cleanly is
far more valuable than a completed task built on a guess.

---

## When Stuck (Before Raising an Issue)

- **leviathan-crypto API mismatch**: check `lib/` imports against the actual
  TypeScript `.d.ts` declarations in
  `cli/node_modules/leviathan-crypto/dist/` or
  `lib/node_modules/leviathan-crypto/dist/`. These are extracted at `bun i`
  time and are the ground truth.
- **WebSocket message not arriving**: verify the server's relay/broadcast
  logic against `server/src/types.ts`. Check that `type` field casing matches
  exactly — the server routes on `type` string equality.
- **Crypto operation throwing**: verify that `init()` was called with all
  required WASM modules before the failing call. Most leviathan-crypto errors
  at runtime are init-order problems.
- **Conflict between files**: `./docs/PROTOCOL.md` > task file > any other
  file. Raise conflicts rather than resolving them silently.
- **Uncertainty about a design decision**: check `./docs/PROTOCOL.md`. If it
  is not covered there, raise an issue rather than deciding unilaterally.
