# COVCOM Agent Instructions

This file is the contract for all AI-assisted development on this repository.
Read it in full before starting any work.

---

## What This Project Is

COVCOM is a post-quantum end-to-end encrypted group chat application built on
[leviathan-crypto](https://github.com/xero/leviathan-crypto). It ships as a
Docker container (server + bundled web client), a standalone web page,
compiled Bun CLI and server binaries, and npm packages (`covcom`,
`covcom-server`) that wrap those binaries.

The server is a dumb WebSocket broker. It knows room IDs and active
connections. It stores no messages, no keys, and no user data. All
cryptographic operations happen in the client.

Read `./docs/PROTOCOL.md` before starting any implementation work. It defines
the crypto protocol, the session lifecycle, and the group messaging model in
narrative form. Byte-level wire format and invite encoding live in
`./docs/CRYPTOGRAPHY.md`. If something in your task file conflicts with
either, the doc wins; flag the conflict rather than resolving it silently.
Per-app internals specs live in `./docs/LIB-SPEC.md`, `./docs/SERVER-SPEC.md`,
`./docs/WEB-SPEC.md`, and `./docs/CLI-SPEC.md`; read the one for the app you
are touching.

For implementation specifics like method signatures, return shapes, and error
conditions, the leviathan-crypto TypeScript type declarations are the ground
truth, not the protocol doc. If the two conflict, flag it. The package also ships
`./lib/node_modules/leviathan-crypto/CLAUDE.md`, a terse API-orientation guide
(init modules, suite hierarchy, cross-cutting foot-guns); read it before the
`.d.ts` to know what to look for, then confirm specifics against the types.

---

## Repository Layout

```
server/             Bun WebSocket server
web/                Vite + vanilla TS web client
cli/                compiled Bun binary, custom zero-dependency TUI
lib/                shared crypto session layer (consumed by web and cli)
scripts/            root tooling: build orchestrator, version codegen,
                    npm staging, release versionbump, dev launcher
docker/             Dockerfile, Caddyfile template, entrypoint
docs/               protocol, cryptography reference, threat model, usage,
                    testing, and the per-app specs (lib, server, web, cli)
package.json        Bun workspace root
AGENTS.md           this file
```

---

## Build & Test

Always run `bun i` first. Every session, no exceptions.

Use these shorthands from the repository root:

```sh
bun i                  # install all workspaces. always run first
bun dev                # run relay + web client together, prefilled to match
bun dev:server         # run server in development mode (watch)
bun dev:web            # run web client dev server (Vite)
bun dev:cli            # run the CLI from source
bun start:server       # run server from source, no watch (production no-docker mode)
bun build:web          # build standalone web client
bun build:cli          # compile CLI binary for current platform
bun build:cli:all      # compile CLI binaries for all target platforms
bun build:server       # compile server binary for current platform
bun build:server:all   # compile server binaries for all release targets
bun bake               # web SPA + every binary target + npm staging
bun run test           # all unit suites in parallel, failures aggregated
bun run test:all       # unit fanout + cross-client interop + Playwright e2e
bun test:server        # server tests only
bun test:lib           # shared lib tests only
bun test:web           # web client tests only
bun test:cli           # CLI tests only
bun test:server:bin    # compile host server binary, run server suite against it
bun test:cross         # web <-> CLI interop over a real relay
bun lint               # eslint report
bun fix                # eslint autofix. run before marking any task done
bun typecheck          # codegen, then tsc --noEmit across every workspace
bun check              # codegen + lint + typecheck + bake + test:all (release gate)
bun build:docker       # build Docker image
bun run:docker         # run container locally for integration testing
```

`bun run test` fans out all four workspace suites concurrently and aggregates
failures. One broken suite does not stop the others, and the exit code is
still nonzero. Each output line carries a `@covcom/<app>:test |` prefix. The
per-app `test:<app>` aliases remain the single-suite loop for focused work.
The fanout flags (`--parallel`, `--no-exit-on-error`, and `--filter` on
`test`; `--workspaces` and `--if-present` on `typecheck`) require the bun
version pinned in `packageManager`; do not run the suite with an older bun.

### Build System

All build aliases dispatch through the root orchestrator:

```sh
bun scripts/build.ts <all|cli|server|web> [--kind binary|npm|spa]
                     [--targets all|<suffix,...>] [--codegen]
```

The orchestrator has two phases and no app knowledge beyond dispatch.
Phase one runs codegen for every selected app: an app exporting
`codegen()` from its `build.ts` owns its full generation set (cli's
covers the banner plus the version module); apps without one get the
shared `bundleVersion()` default from `scripts/version.ts`. Phase two
imports each app's `build.ts` and awaits its exported `build()`. Codegen
precedes all builds as a hard invariant: `web/vite.config.ts` imports
`src/version.ts` at config-load time. Do not add a build path that
compiles without running codegen first.

Generated files are gitignored and never committed: `cli/src/version.ts`,
`server/src/version.ts`, `web/src/version.ts`, and `cli/src/tui/banner.ts`
exist only as codegen output. Codegen-first is load-bearing, not a
convention: a fresh clone has none of these files, so `check`, the root
`typecheck`, and each app's `test` script run codegen before anything that
imports them. The entry points are `bun scripts/build.ts <sel> --codegen`
from the root and bare `bun build.ts` inside an app directory.

A binary build resolving to an app's full target set clears that app's
`dist/` before compiling; a single-target or host build overwrites its own
outfile in place. `bake` output is therefore clean by construction while a
host build (e.g. `test:cross`'s) coexists with just-baked release
binaries.

Every app `build.ts` exports the same contract:

```ts
export const TARGETS: Target[];
export async function build(opts: {
	kind: 'binary' | 'npm' | 'spa';
	targets?: string[];   // suffixes; default: host only
}): Promise<void>;
```

Target lists are data. `TARGETS` carries the npm platform key, the bun
compile target, the release binary filename, and the os/cpu/libc manifest
fields. The compile loop, the npm manifest generator, and the launcher
shim's platform map all consume it, so adding a target is a one-line table
change. Do not hardcode a target name in any consumer.

Standalone invocations work from each app directory: `bun build.ts`
(codegen only), `bun build.ts --compile` (host binary), plus `--targets
all|<suffix,...>` and `--kind npm`. The npm kind stages publish-ready
package trees under `dist/npm/` and always runs the binary kind first in
the same invocation. The web app builds only the `spa` kind, and vite
always runs as a spawned child, never through its JS API.

Published npm names (`covcom`, `covcom-server`, `@covcom/*`) exist only in
generated manifests under `dist/npm/`. Workspace package.json files stay
`@covcom/*` and `private: true`; never put a publishable name in a tree
manifest.

**Never run raw package-level commands like `cd server && bun run dev` directly.**
The root shorthands handle workspace context correctly. The raw equivalents may
skip steps or run with wrong environment configuration.

Always capture test output to a log file and inspect from there:

```sh
bun run test 2>&1 | tee /tmp/test.log
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
Anything involving the leviathan-crypto API (method signatures, init
requirements, return shapes, error conditions) comes from the library's
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
without exception. Do not commit even if the task file says the work is
complete.

### 8. Never revert with `git checkout --` over a dirty tree

Never revert files with `git checkout --` while the tree carries
staged-plus-unstaged work; it silently restores the index copy and destroys
the unstaged half. Revert probes and experiments with `cp` backups or
`git stash` instead. This destroyed unstaged work in two sessions in a
single day.

---

## Code Style

- **Tabs, not spaces** for indentation throughout
- **Unix line endings**
- **Terse over verbose**: inline conditionals, short variable names, no
  unnecessary intermediates
- **No comments that restate the code**: comments explain why, not what
- **NEVER use emdashes or endashes**: rewrite the sentence or use
different punctuation. Ranges use a regular hyphen.
- **Spec citations in source**: cite the section. Example:
`// FIPS 180-4 §4.1.2, Ch function`; use `§` as the section symbol.
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
- The server ships from one entrypoint in two launch modes: `bun run
  src/index.ts` and a compiled binary (`bun build:server`). One behavior,
  two launchers: no compiled-only or source-only code paths, and flags and
  env vars behave identically in both. `server/test/util.ts` runs the same
  black-box suite against either mode, selected by `COVCOM_SERVER_BIN`.
- The server reads nothing from disk and never resolves paths via
  `import.meta.dir`, because compiled binaries map source paths into an
  embedded virtual filesystem. Any future config file support must use
  explicit cwd or XDG paths.

**Create and join entry points converge on a single post-`joined` path**

Both clients route room creation and room joining through one shared
post-`joined` handler. In the CLI (`cli/src/state.ts`) the entry points
are `doCreate` and `doJoin`, and they converge on `doConnect`. In the web
client (`web/src/session.ts`) the entry points are `CovcomSession.create`
and `CovcomSession.join`, and they converge on `_onJoined`. The shared
handler owns identify, handshake, lobby/ready transitions, message
handlers, and the close handler. Do not duplicate post-`joined` logic
across the two entry points.

The welcome ratchet fires inside this shared handler only, after all
expected chain seeds have been received. It does not fire anywhere else.

**Shared crypto layer (`lib/`)**

- `lib/` is the primary crypto layer and the single source of the
  `leviathan-crypto` dependency. Both `web/` and `cli/` import only from
  `@covcom/lib` and never name `leviathan-crypto` directly, so the pinned
  version stays single-sourced and the two clients cannot drift onto separate
  WASM instances. `cli/test/crypto-source.test.ts` enforces this: it fails if
  the cli regrows a direct dependency or import.
- `lib/` exposes a session API, not a raw crypto API. Callers should not need
  to touch `KDFChain` or `Seal` directly.
- WASM modules are loaded once at session start via `lib/`'s `initCrypto`,
  which both clients call (`web/src/main.ts`, `cli/src/main.ts`) and which is
  idempotent. The compiled cli binary initializes through this same path; the
  cross-client test exercises it end to end.

**Web client**

- Vanilla TS with Vite. No framework. No React, Vue, Svelte, or equivalent.
- The web client has a single code path regardless of deployment context.
  Do not introduce container-specific forks or build-time env var injection
  into client logic.
- File drag-drop accepts drops anywhere on the page during an active session.
  The drop zone overlay is CSS only; no JS animation library.
- The text input does not grow beyond its set height. It scrolls internally.
  `Shift+Enter` inserts a newline. `Enter` sends.
- The web client is structured around a small Redux-shaped store. Protocol
  state lives in `web/src/session.ts` (a `CovcomSession` that emits events
  via `web/src/emitter.ts`); UI state lives in `web/src/store.ts` (screen,
  chat, sidebar, event log); `web/src/bridge.ts` adapts session events to
  store actions and produces event-log entries from inbound/outbound wire
  frames. Per-view DOM mount/unmount lives in `web/src/views/` (`shell.ts`,
  `landing.ts`, `joining.ts`, `join.ts`, `waiting.ts`, `chat.ts`,
  `header-nav.ts`, `sidebar.ts`, `event-log.ts`, `verify.ts`). Do not
  re-merge session and UI state, and do not bypass the bridge to write to
  the store from session code.
- File transfer streams on the main thread with `SealStream`/`OpenStream` (one
  bounded chunk per `broadcast` frame; see `lib/src/filetransfer.ts` and the
  `sendFile`/`_onFileBegin`/`_onFileChunk` paths in `web/src/session.ts` and the
  mirror in `cli/src/state.ts`). No Web Worker is spawned, so the web client is a
  true single-file SPA and the CSP (`web/vite.config.ts`) is `default-src 'none'`
  with no `worker-src`. Main-thread streaming is what keeps the client a
  single-file SPA under that policy, so do not add a `SealStreamPool` or a pool
  worker for files. See `../leviathan-crypto/docs/csp.md`.

**CLI**

- The TUI is a custom zero-dependency implementation. No neo-neo-blessed, no
  terminal-kit, no blessed, no external TUI library of any kind. Read
  `./docs/CLI-SPEC.md` before touching any file under `cli/src/tui/`.
- `cli/src/tui/` contains:
  - infrastructure: `screen.ts`, `keys.ts`, `focus.ts`, `widgets.ts`
    (TextInput, TextArea, Button, ScrollView, Sidebar, Modal)
  - rendering implementation: `views.ts`, plus `qr.ts` (the half-block
    terminal renderer for the shared `qrMatrix` encoder)
  - per-screen façades that re-export from `views.ts`: `landing.ts`,
    `waiting.ts`, `join.ts`, `chat.ts`
  - generated asset: `banner.ts` (rebuilt by `build.ts`; do not edit by
    hand)

  Do not add files outside this structure without flagging it.
- `cli/src/eventLog.ts` is a top-level CLI module (not under `tui/`). It
  holds the capped ring buffer that backs the Sidebar's event-log pane;
  its `EventLogEntry` shape mirrors `web/src/store.ts` so the two clients
  surface the same data. Mutate it only via `logEvent` and reset on
  session teardown.
- `cli/src/lifecycle.ts` is another top-level CLI module. It exposes
  `registerCleanup`/`doCleanup`: the single teardown path that wipes session
  state and restores the terminal. `state.ts` registers session/socket
  teardown via `registerCleanup`, and `main.ts` runs `doCleanup` from its
  exit-signal handlers.
- The public interface between `cli/src/state.ts` and the TUI is fixed.
  `state.ts` imports through the per-screen façades:
  - `renderLanding` and `renderCreate` from `tui/landing.ts`
  - `renderWaiting` from `tui/waiting.ts`
  - `renderJoin` from `tui/join.ts`
  - `renderChat`, `appendMessage`, `appendFile`, `showModal` from `tui/chat.ts`

  `cli/src/main.ts` imports `createScreen()` from `tui/screen.ts` and
  `doCleanup()` from `lifecycle.ts`. Do not change these signatures or
  relocate exports without flagging it as a deviation.
- Config is stored at `~/.config/covcom/config.json`. Fields: `server`,
  `username`, `copyCmd`, `theme`, `showSystem`, `sidebar`, `icons`. No key
  material.
- The CLI accepts `covcom --join <path>` (`-j`), plus two config-privacy
  flags: `--clean` (`-x`, ignore the config file entirely, no read or write)
  and `--anon` (`-a`, skip only the saved server and username). It also
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
- A `relay` `payload` carries a client-only one-byte tag (`0x00` chain seed,
  `0x01` file-transfer ack) kept in lockstep across web and cli. The server
  never inspects it. A half-applied tag breaks the chain-seed handshake, not
  just file transfer.
- Error reason values: `room_full`, `not_found`, `forbidden`, `username_taken`,
  `version_mismatch`. Do not introduce new error reasons without flagging it.
- The `create` and `join` messages carry `protocolVersion`; the `room_created`
  and `joined` replies carry `serverVersion`. See the version-negotiation note
  below before touching these fields.

**Wire versioning is locked to leviathan-crypto.** All covcom ctx strings
carry a `-v3` suffix (`covcom-identity-claim-v3`, `covcom-message-sig-v3`)
so they track the leviathan-crypto signing API surface this code targets.
When leviathan-crypto bumps to a new major version, covcom's ctx strings
bump in lockstep in the same PR. Do not introduce a v3 ctx string when
targeting v4, or vice versa. If you need to evolve a ctx string without
bumping the library, raise an issue.

**The protocol manifest is the single source of truth.** `lib/src/protocol.ts`
owns `PROTOCOL_VERSION` (covcom's own wire-contract integer) and the `PROTOCOL`
manifest: the cipher and KEM display names, the cipher and signature format
bytes, and the auto-ratchet interval. Web, cli, and server all read from it,
mirroring the `FILE_CHUNK_SIZE` source-of-truth pattern. Do not re-hardcode any
of these values in a client; the stale CLI `0x01` format byte was exactly that
drift. The format bytes are derived from the suite objects
(`XChaCha20Cipher.formatEnum`, `Ed25519PreHashSuite.formatEnum`), so no literal
can drift again. `PROTOCOL_VERSION` is hand-bumped and is deliberately
independent of the leviathan-crypto version and the `-v3` ctx suffix: the covcom
wire contract can break without a cipher change, and leviathan can bump a format
enum without breaking covcom.

**Version negotiation runs at join, and is a compatibility gate, not a security
boundary.** The server rejects a missing or mismatched `protocolVersion` with a
`version_mismatch` error and closes the socket, before any room or username
work. Each client rejects a missing or mismatched `serverVersion` the same way,
so the check is bidirectional and whichever side is newer catches the skew. The
version rides in plaintext; do not bind it into any crypto operation, and do not
treat it as authenticated, since a hostile server can lie about it. The server
reads `PROTOCOL_VERSION` from `@covcom/lib` (its only dependency on the lib) and
still performs no crypto and stores nothing.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DOMAIN` | required | FQDN passed to Caddy |
| `PORT` | `1337` | Internal port the Bun server listens on |
| `HOST` | `127.0.0.1` | Interface the Bun server binds; `0.0.0.0` exposes it directly |
| `ADMIN_TOKEN` | unset | Optional creation-only auth gate |
| `ROOM_TTL` | `24` | Hours of inactivity before room deletion; `0` = never |
| `MAX_ROOM_SIZE` | `20` | Max participants per room; `0` = unlimited |

Every variable except `DOMAIN` (Caddy is Docker-only) has a matching server
command-line flag in `server/src/flags.ts`. Precedence is flag > env var >
default.

---

## Definition of Done

A task is complete when **all** of the following are true:

1. `bun run test` passes for all packages touched by the task (never bare
   `bun test`; see Build & Test above)
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
# Issue: [short title]

## Status
Blocked. Implementation work stopped at [file / function / test].

## What I was trying to do
[The specific task or step that hit the blocker]

## What I tried
[Each attempt, in order, with the result of each. Be specific: include
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
  TypeScript `.d.ts` declarations in `lib/node_modules/leviathan-crypto/dist/`
  (lib owns the dependency). These are extracted at `bun i` time and are the
  ground truth.
- **WebSocket message not arriving**: verify the server's relay/broadcast
  logic against `server/src/types.ts`. Check that `type` field casing matches
  exactly. The server routes on `type` string equality.
- **Crypto operation throwing**: verify that `init()` was called with all
  required WASM modules before the failing call. Most leviathan-crypto errors
  at runtime are init-order problems.
- **Conflict between files**: `./docs/PROTOCOL.md` > task file > any other
  file. Raise conflicts rather than resolving them silently.
- **Uncertainty about a design decision**: check `./docs/PROTOCOL.md`. If it
  is not covered there, raise an issue rather than deciding unilaterally.
