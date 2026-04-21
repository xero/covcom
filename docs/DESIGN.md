# leviathan-messenger v3 protocol design

> [!NOTE]
> Working design notes for the v3 rewrite. Records decisions made, constraints,
> and resolved questions. This is a living document, not a final spec.

> ### Table of Contents
> - [context](#context)
> - [screen nomenclature](#screen-nomenclature)
> - [core model change](#core-model-change)
> - [epoch model](#epoch-model)
> - [join-triggered ratchet](#join-triggered-ratchet)
> - [manual ratchet](#manual-ratchet)
> - [simultaneous joins](#simultaneous-joins)
> - [reconnect after disconnect](#reconnect-after-disconnect)
> - [late joiner epoch sync](#late-joiner-epoch-sync)
> - [implementation constraints](#implementation-constraints)
> - [security properties](#security-properties)
> - [settled decisions](#settled-decisions)
> - [resolved design questions](#resolved-design-questions)
> - [what stays from v2](#what-stays-from-v2)
> - [what changes from v2](#what-changes-from-v2)

---

## context

v1 was bug testing and migrating logic into the lib. v2 proved the new crypto
primitives worked and fixed correctness issues discovered in testing. v3 is the
production-grade design. app requirements drive library changes, not the other
way around.

---

## screen nomenclature

Four screens exist in both clients. Use these names consistently in code,
comments, and task files.

- **main** — entry screen. create room or switch to join screen.
- **join** — select a `.room` file or paste invite text to join a room.
- **lobby** — displays the invite code (QR + armored text). Three situations
  bring a client here:
  1. new room creation (creator waits for first peer)
  2. joining a room that exists but has zero active peers
  3. an active chat drops to zero peers (last peer left or disconnected)
- **chat** — the active group chat screen.

**AppState phase mapping:**
- `'landing'` → main screen
- `'waiting'` → lobby screen
- `'joining'` → transitional during WS handshake before `joined` arrives
- `'ready'` → chat screen

In v3, `'ready'` → `'waiting'` is a new transition (lobby on zero peers). The
phases are no longer strictly one-directional.

---

## core model change

v2 used per-sender epochs. each participant owned their send epoch independently
and advanced it only when they clicked the rotate button. this created problems:

- late joiners received epoch-0 material but senders were at epoch N, causing
  silent decryption failures
- members who never rotated stayed at epoch 0 indefinitely
- the bilateral send chain advance (removed in v2) broke N>2 rooms

v3 keeps per-sender epochs but fixes the late joiner problem by distributing the
current epoch seed in relay blobs instead of the original chain seed. each
participant still owns their own send chain (Sender Keys model preserved). the
join-triggered ratchet ensures every new participant starts fresh.

---

## epoch model

Epochs are **per-sender**, not per-room. Each participant owns their own epoch
counter, advancing it only when they personally initiate a ratchet step. There
is no shared room-wide epoch counter.

Each participant's `Session` exposes two read-only getters:
- `epoch` — the current outgoing epoch (`_myEpoch`)
- `counter` — the current outgoing chain position (`_myChain.n`)

These are needed by the state machine. The receive side (per-sender chains) stays
internal — the state machine never inspects receive chain counters directly.

The epoch number is encoded in every broadcast message header so recipients
know which send chain to use. The existing `epoch` field in `MessageEnvelope`
already does this.

---

## join-triggered ratchet

**Decision:** the joining client initiates the welcome ratchet, not the existing
members and not a designated host.

Rationale: the joiner is always present at join time by definition. No host
election needed. The protocol stays symmetric.

Flow when xero joins a room where alice is at epoch 0 and bob is at epoch 2:

1. xero sends `identify`
2. server sends `peer_joined(xero)` to alice and bob
3. alice sends xero a relay: `Seal(xero.ek, epoch=0 || alice._currentEpochSeed)`
4. bob sends xero a relay: `Seal(xero.ek, epoch=2 || bob._currentEpochSeed)`
5. xero decrypts both relays, sets up `_senderState['alice']` at epoch 0
   and `_senderState['bob']` at epoch 2
6. xero initiates a ratchet step — xero advances from epoch 0 to 1
7. alice and bob process xero's `ratchet_step`, set up `_senderState['xero']`
   at epoch 1, send `ek_update`
8. xero is now a full participant. alice epoch 0, bob epoch 2, xero epoch 1.

Existing members send their current epoch seed in a relay on every `peer_joined`.
The epoch encoded in the relay tells the joiner exactly where that sender is.

**Message drop window.** Between receiving `joined` and transitioning to `ready`,
broadcasts from existing members are silently dropped. The window is milliseconds
in practice. This is correct "you weren't there" behavior.

---

## manual ratchet

Keep the manual rotate button (R in CLI, lock icon in web). A user who wants
forward secrecy from a specific moment, independent of join events, should be
able to trigger it. Manual ratchet follows the same flow as any other ratchet
step.

---

## simultaneous joins

When two clients join in rapid succession, the server serializes `peer_joined`
events. WebSocket over TCP guarantees all existing members receive them in the
same order.

Both the server and client message handlers are plain synchronous functions with
no `async` or `await` in the ratchet path. Bun's JavaScript event loop gives an
atomicity guarantee: when xero's `ratchet_step` arrives, `handleRatchetStep`
runs to completion before yvonne's join can be processed.

Example: alice and bob at epoch 0. xero and yvonne join back to back.

- server delivers `peer_joined(xero)` to alice and bob
- alice and bob each send xero a relay with their epoch-0 seed
- xero receives both relays, goes ready, fires welcome ratchet (xero → epoch 1)
- alice and bob process xero's ratchet step; `_senderState['xero']` = epoch 1
- server delivers `peer_joined(yvonne)` to alice, bob, and xero
- all three send yvonne a relay: alice → epoch 0, bob → epoch 0, xero → epoch 1
- yvonne goes ready, fires welcome ratchet (yvonne → epoch 1)
- alice, bob, xero process yvonne's ratchet step; `_senderState['yvonne']` = epoch 1

Final state: alice epoch 0, bob epoch 0, xero epoch 1, yvonne epoch 1. All four
can encrypt and decrypt correctly.

---

## reconnect after disconnect

WebSocket connections drop — mobile networks, sleep/wake, network switching.
When a client disconnects, the server fires `handleClose`, removes the connection
from the room, and broadcasts `peer_left` to remaining members. The room is NOT
deleted when peers reach zero. Rooms persist until the TTL cleanup cron fires.

**Client reconnect flow:**

1. WebSocket close detected → show offline banner, disable chat input
2. Do not clear chat history — messages already on screen stay visible
3. Ping `/health_check` (HTTP GET, returns 200 OK) in a loop with backoff
4. On 200, re-open WebSocket to the server
5. Send `join` with saved `roomId` and `roomSecret`
6. Receive `joined`, send `identify` with fresh keypair
7. Normal handshake proceeds — existing members send epoch seeds, client
   fires welcome ratchet, transitions to chat

Messages sent while offline are unrecoverable. This is correct FS behavior.

If the username was taken by another client while offline, `identify` returns
`username_taken`. The main screen re-appears so the user can choose a new name.

**Client state to persist across disconnects** (no key material — parse and hold
these from the original invite + user input):
- `roomId`
- `roomSecret`
- `dns`
- `username`

These four fields live on both `AppState.waiting` and `AppState.ready`. The
armoredInvite string is never stored; it is derived on demand via
`makeArmoredInvite(roomId, roomSecret, dns)`.

**Room TTL and cleanup:**

- `ROOM_TTL` env var: hours of inactivity before deletion. `0` = never. Default: 24.
- `lastActivity` timestamp on each Room, updated whenever the server processes
  any message for that room.
- Cleanup condition: `now - lastActivity > ROOM_TTL && conns.size === 0`.
- Rooms with active connections are never deleted by the cron regardless of age.
- Bun cron (`Bun.cron`) runs cleanup once at server start, then on schedule.

---

## late joiner epoch sync

When an existing member receives `peer_joined(C)`, they wrap their
`_currentEpochSeed` plus the current epoch number in the relay blob — not the
original `_chainSeed`.

Blob format: `Seal(peerEk, epoch[4] || seed[32])` — 36 bytes plaintext,
4-byte little-endian uint32 epoch prefix.

`unwrapChainSeed` reads the epoch from the first 4 bytes and sets up
`_senderState[sender]` at that epoch. The full 36-byte plain buffer must be
wiped after slicing — wiping only the seed slice leaves the epoch prefix in
memory.

`_currentEpochSeed` is a new field on `Session`:
- initialized to `_chainSeed.slice()` in the constructor (epoch 0, same value)
- updated in `commitRatchetStep` before wiping `_pendingRatchetSeed`
- wiped in `dispose()`

Ratchet root symmetry holds because both sides call `ratchetInit(_currentEpochSeed)`
with the same seed — the existing member in `wrapChainSeedFor`, the late joiner
in `unwrapChainSeed` after decryption. Both derive the same `nextRootKey` without
extra communication.

A late joiner only decrypts messages from their join epoch onward. Pre-join
history is not recoverable. This is correct forward secrecy behavior.

**Invite format (v3).** The invite no longer contains `ekCreator` or `authToken`.
The binary layout is `version(1) + roomId(32) + roomSecret(16) + dns(variable)`.
The fixed portion is 49 bytes. Without a dns field this armors to roughly 160
chars, enabling small QR codes (fits QR v10 binary mode). The joining client
gets the creator's live `ek` from the `members` array in `joined`, not from the
invite. This eliminates the last structural distinction between the room creator
and any other participant.

The version byte stays `0x01`. Wire format changes (dropping `ekCreator`, adding
`roomSecret`) happen within the same version because no clients are deployed.
The `INVITE_VERSION` constant in `lib/src/invite.ts` is the single source of
truth for all encode and decode paths.

---

## implementation constraints

These constraints are load-bearing for correctness. Capture all of them in
AGENTS.md and any relevant TASK.md files for v3.

---

**`create` flow — creator sends `join` like any other client.**
`handleCreate` generates `roomSecret`, creates the room, and returns
`room_created { roomId, roomSecret }`. It does NOT add the WebSocket to
`room.conns`. After receiving `room_created`, the client builds the invite,
then sends `join { roomId, roomSecret }` on the same WebSocket. The server
handles this exactly like any other join: validates `roomSecret`, adds the
connection, returns `joined { members: [] }`. The client then sends `identify`
and enters the lobby.

This makes the creator indistinguishable from any other participant once
identified. It also means the creator always appears in `joined.members` for
subsequent joiners, which fixes the v2 bug where early joiners saw an empty
members list when the creator had not yet identified.

Agents must not add `room.conns.add(ws)` to `handleCreate`. Agents must not
skip the `join` step in the `doCreate` client flow.

---

**`doCreate` and `doJoin` share a common handler via `doConnect`.**
Both entry points converge on the same post-`joined` protocol. Factor this into
a shared function:

```
doConnect(ws, roomId, roomSecret, dns, username, members)
```

`doCreate` calls `doConnect` after receiving `room_created` and sending `join`.
`doJoin` calls `doConnect` after receiving `joined`. `doConnect` owns everything
from `identify` onward: the handshake, lobby/ready transitions, all message
handlers, and the close handler.

---

**`makeArmoredInvite` helper.**
A module-level helper in both state machines derives the invite string from its
component parts:

```ts
function makeArmoredInvite(roomId: string, roomSecret: string, dns?: string): string {
    return armorInvite(serializeInvite({ version: INVITE_VERSION, roomId, roomSecret, dns }))
}
```

Call it wherever the lobby needs to render: initial lobby entry, lobby
re-render on chat → lobby transition. The string is never stored in AppState.

---

**Ratchet path must stay synchronous.**
The `onMessage` WebSocket handler runs to completion before the next message is
processed. This is guaranteed by the JavaScript event loop only if the ratchet
path contains no `await` points. `doRatchetStep`, `performRatchetStep`, and
`commitRatchetStep` must remain plain synchronous functions. Async work (file
encryption, pool operations) must be fire-and-forget via `.catch()`.

If an `await` is introduced between `peer_joined` and completing the ratchet
step, the atomicity guarantee breaks and simultaneous join sequencing fails.

---

**Receiving a ratchet step must never trigger sending one.**
The only three triggers for an outbound `ratchet_step` are:
- `peer_joined` (join-triggered welcome ratchet, fired from `doConnect` only)
- user pressing the rotate button (manual ratchet)
- `session.counter >= AUTO_RATCHET_INTERVAL` before sending a message

Processing an inbound `ratchet_step_fwd` only updates receive state. It never
sends anything except `ek_update`. This prevents ratchet loops.

The welcome ratchet fires inside `doConnect` after all expected chain seeds are
received. It does NOT fire in `doCreate`'s `room_created` handler or anywhere
outside `doConnect`.

---

**Server remains a dumb broker.**
The server never interprets payload contents, never stores keys, and never
participates in epoch tracking.

---

**`peer_left` must remove the departed member from `st.peers`.**
Departed members remaining in `st.peers` cause wasted KEM encap on every
subsequent ratchet step. `Session` exposes `removePeer(username)` which wipes
and removes all state for that sender (`_senderState`, `_oldSenderState`,
`_encapRoots`, `_decapRoots`, `_peerRatchetEks`). If the member rejoins, the
full handshake re-establishes all state fresh.

---

**`doRatchetStep` must guard against empty peers.**
If `st.peers` is empty, `performRatchetStep` is never called so
`commitRatchetStep` throws "no pending ratchet step." Add
`if (st.peers.size === 0) return` at the top of `doRatchetStep`. The
auto-ceiling check must also gate on `st.peers.size > 0`.

---

**Lobby transition — three situations.**

Clients enter the lobby screen in three situations:

1. New room creation — creator sends `join` after `room_created`, receives
   `joined { members: [] }`, sends `identify`, enters lobby. Handled by
   `doConnect` like any other empty-room join.
2. Joining with `members = []` — same path as situation 1. `doConnect`
   sends `identify` and enters lobby rather than hanging on an unsatisfiable
   handshake.
3. Active chat drops to zero peers — `peer_left` fires and `peers.size === 0`.

**Situation 3 — chat → lobby transition:**

1. Kill any in-flight file pool immediately via `pool.destroy()`. The
   `try/finally` pattern ensures `msgKey` is wiped regardless.
2. Dispose the current session, wiping all key material.
3. Reset `chainsExpected = 0` and `chainsReceived = 0` — these are
   closure-local variables in `doConnect`. Stale values would cause the next
   handshake to fire the ready condition at the wrong time.
4. Generate a fresh session with a new keypair.
5. Send `rekey` to the server with the new `ek` and `ratchetEk`. Wait for
   `rekeyed` confirmation before rendering. The server verifies via WebSocket
   identity (`ws.data.username !== null`), updates ConnData silently, and
   sends no `peer_joined` broadcast.
6. Render lobby UI — do NOT clear the chat history.

**Preserving chat history on lobby transition.**
Chat messages already rendered to the DOM (web) or scrollback buffer (CLI) must
not be cleared. The lobby UI replaces only the input bar and shows the invite
code. If a peer reconnects, the conversation continues visually from where it
left off.

Web: straightforward — overlay lobby controls, leave message list intact.
CLI: best-effort. If preserving the scrollback buffer is not feasible, the CLI
may clear on lobby transition. This is an accepted fallback for the CLI only.

When a `peer_joined` arrives while in lobby, the normal handshake fires: wrap
seed, send relay, increment `chainsExpected`, receive relay, welcome ratchet,
transition to chat.

Both clients need a new `chat → lobby` UI path. The CLI currently has no
`ready → waiting` flow and must implement one.

---

**`AppState` must carry reconnect fields on `waiting` and `ready`.**
Both phases store `roomId`, `roomSecret`, `dns`, and `username`. These are the
four values needed to re-enter the room after a disconnect. The `armoredInvite`
string is not stored; call `makeArmoredInvite` when the lobby needs to render.

`AppState.joining` is a brief transitional phase used during the initial WS
handshake. It holds only what is needed to send `join` and handle `error`
responses before `joined` arrives. The `authToken` field is removed; there is
no per-join credential in v3.

---

**`rekey` wire type — WebSocket connection as identity proof.**
`rekey` is used only for the lobby-transition case (connection still live).
On a real disconnect/reconnect, the server has already cleaned up ConnData via
`handleClose` — alice sends a normal `join` + `identify` with her fresh keys.

For the lobby transition: `handleRekey` checks `ws.data.username !== null`
(proves the connection was previously authenticated) and silently updates
ConnData. No nonce needed — an attacker cannot rekey as alice without
controlling her open TCP connection.

Wire: `{ type: 'rekey', ek: string, ratchetEk: string }`.
Response: `{ type: 'rekeyed' }`.

---

**WebSocket close handler must cover `'waiting'` phase.**
The current close handler only acts when `current.phase === 'ready'`. In v3 a
client can be in `'waiting'` phase with an open WebSocket (lobby state, or
during initial handshake). A drop from `'waiting'` must show the offline banner
and enter the health-check retry loop — same as dropping from `'ready'`.

---

**`_chainSeed` wiped at first ratchet step.**
After `commitRatchetStep` assigns `_currentEpochSeed`, `_chainSeed` has no
further use. Add `wipe(this._chainSeed)` immediately after. Update `dispose()`
to guard against double-wipe (zero-idempotent wipe is fine; do not null the
field).

---

**Key hygiene: wipe before overwrite on map entries.**
`wrapChainSeedFor` and `unwrapChainSeed` overwrite map entries without wiping
old values first. The correct pattern — already used by `updatePeerRatchetEk`
and the ratchet step methods — is get, wipe, set. Specifically:
- `wrapChainSeedFor`: wipe old `_encapRoots.get(peer)` before setting new nextRootKey
- `unwrapChainSeed`: wipe old `_decapRoots.get(sender)`; dispose old
  `_senderState.get(sender).chain` before overwriting

Note: `_encapRoots`, `_decapRoots`, `_senderState`, and `_oldSenderState` are
all `Map` instances. Use `.get()`, `.set()`, and `.has()` — not bracket indexing.

---

**`msgKey` must be wiped in a `try/finally` block.**
`SealStreamPool._killAll` wipes the pool's internal key copy on error, but the
caller's `msgKey` is a separate allocation only wiped on the success path. The
web client's `doSendFile` and `doReceiveMessage` (file branch) must be updated
to wrap pool operations in `try/finally` with `wipe(msgKey)` in the `finally`
block. The CLI already implements this correctly and requires no change.

---

**`EPOCH_KEEP_WINDOW` must be a named constant.**
Define `const EPOCH_KEEP_WINDOW = 2` at module level in `session.ts`. Used in
both the pruning loop in `receiveRatchetStep` and the boundary check in
`_resolveKey`. Already implemented.

---

## security properties

**Forward secrecy (FS):** continuous. Each message uses a unique key from the
current KDF chain. The chain key is stepped forward immediately and the old
value wiped — a later device compromise cannot decrypt past messages.

**Post-compromise security (PCS):** at ratchet step boundaries only. Between
triggers, a compromised device can decrypt all messages on that send chain until
the next ratchet fires. This is a fundamental property of sparse ratcheting
(Signal spec §8.9). PCS boundaries are defined by three triggers:
- join-triggered welcome ratchet
- manual rotate
- `AUTO_RATCHET_INTERVAL` (default 25 messages, user-configurable)

The skipped-key cache holds at most `maxCacheSize` keys (default 100,
tightened from the 2.0-beta `ceiling: 500`); older keys are evicted FIFO.
A single `resolve` cannot deposit more than `maxSkipPerResolve` (default 50)
keys — a per-message HKDF-work bound that closes a CPU-amplification channel.
Combined, the maximum PCS exposure window is bounded at 100 messages, well
above covcom's 25-message auto-ratchet cadence. The epoch-transition path
`advanceToBoundary` is also bounded by `maxSkipPerResolve`, so a malicious
header with `pn > 50` fails loudly at the rotate site rather than silently
amplifying work — covcom's 25-message auto-ratchet keeps `pn ≤ 25` in
practice, well under the 50 cap. Per-sender independence: alice's PCS window
is governed by alice's own triggers, independent of bob's.

---

## settled decisions

**Auto-ratchet interval: configurable, default 25.**
The state machine checks `session.counter >= AUTO_RATCHET_INTERVAL` in
`doSendMessage` and `doSendFile` before sealing. Fires only when
`st.peers.size > 0`. Default 25 — at normal chat pace this gives a PCS boundary
roughly every 6-12 minutes, ~0.15ms encap per peer, invisible to the user.

Each participant enforces their own interval independently. Alice at 25 and bob
at 100 coexist without conflict — epochs are per-sender.

The check must NOT be inside `sealMessage` — `doRatchetStep` calls `sealMessage`
and putting the check there would cause infinite recursion.

Benchmarks (sandbox, 50 trials): encap ~0.13ms median, decap ~0.25ms median,
4-person 300-message session with 5 ratchets: ~60ms total / 0.20ms per message.
Per-message ratcheting with 10 peers: ~1.5ms per send — imperceptible.

**Solo user counter overflow — mitigated by lobby transition.**
When the last peer leaves, the lobby transition disposes the session and resets
the counter to 0. The only residual case — room creator before anyone joins —
cannot send messages in lobby state, so the counter never advances solo.

**`_oldSenderState` pruning — keep N-2 (3 epochs total).**
When advancing a sender to epoch N, prune `_oldSenderState[sender]` entries
older than N-2 (wipe chain and store, delete map entry). This keeps epochs N,
N-1, and N-2 — intentionally one wider than Signal spec's `ClearOldEpochs`
(§5.7), which keeps only N and N-1. The wider window improves out-of-order
delivery tolerance across two epoch boundaries. Pruning happens inside
`receiveRatchetStep` — the state machine never manages epoch history directly.
Already implemented.

**`_resolveKey` error messages — three distinct cases.**
- `epoch > currentEpoch` → "message is from a future epoch, ratchet step not yet received"
- `epoch < currentEpoch - EPOCH_KEEP_WINDOW` → "message is too old to decrypt"
- epoch in valid window but key not in store → "key not found"

The first two are expected operational states. The third is the only genuine
failure. All three surface as system messages in the UI via `.catch()`.
Already implemented.

**Credential model — two credentials, three concerns.**

- `adminToken` — server-level gate on room creation. Set via `ADMIN_TOKEN`
  env var at runtime; defaults to empty string (no restriction). Client sends
  with `create`. Never in the invite, never baked into the web client bundle.
  UI label: "server password."
- `roomSecret` — per-room join credential. Server-generated 16 Fortuna bytes
  at `create` time, returned in `room_created`, embedded in invite. All joins
  must present it. Provides enumeration resistance. No UI field needed — it
  comes from the invite blob automatically.
- `authToken` — retired. Replaced by the above two.

`VITE_AUTH_TOKEN` and `VITE_SERVER_DNS` build args are both removed. The
Dockerfile has zero build args. All configuration is runtime env vars.

**Known limitation — username taken on reconnect.**
If another client claims a username while the original holder is offline, that
user gets `username_taken` on rejoin and must choose a new name. First-come-
first-served with no persistent accounts. Acceptable for ephemeral chat.

**Known limitation — invite format is a clean break from v1 wire format.**
The v3 invite drops `ekCreator` and `authToken`, adds `roomSecret`. The version
byte stays `0x01` because no clients are deployed; this is a pre-release wire
break within the same version number. Any existing `.room` files are invalid
and must be regenerated. The parser will fail to decode old blobs since the
expected binary offsets have changed.

**Known limitation — no PN (previous chain length) in `ratchet_step`.**
The Signal spec (§5.7) describes a sealed-chain approach that lets receivers
wipe old epoch chains as soon as they can no longer receive new messages. Our
`ratchet_step` does not carry `prev_epoch_length`, so old chains wait for the
N-2 prune window. For ephemeral chat this is acceptable. Adding
`prev_epoch_length` to the wire is a future option.

---

## resolved design questions

**Buffer aliasing in `commitRatchetStep`.** `KDFChain` calls `ck.slice()` in
its constructor — independent copy immediately. `wipe()` zeroes in-place.
Correct sequence:

```
this._myChain.dispose()
this._myChain = new KDFChain(this._pendingRatchetSeed)    // copies internally
this._myEpoch++
this._currentEpochSeed = this._pendingRatchetSeed.slice() // independent copy
wipe(this._pendingRatchetSeed)                            // zeroes pending buf
this._pendingRatchetSeed = null
this._pendingRatchetPn   = 0
wipe(this._chainSeed)                                     // no longer needed
```

Three buffers, zero aliasing. `dispose()` must wipe `_currentEpochSeed`
alongside `_chainSeed`.

**`ratchetInit` input choice.** Using the raw epoch seed as the `KDFChain`
input is intentional. Both sides hold the same seed and independently call
`ratchetInit(seed)` — symmetric derivation, no extra communication needed.
Security is equivalent because `ratchetInit` applies HKDF internally.

**Per-message key deletion (G5).** `KDFChain.step()` wipes `okm` after slicing
and returns `msgKey` as a separate allocation. `sealMessage` and `openMessage`
wipe `msgKey` after AEAD. `SkippedKeyStore` deletes the entry on retrieval.
`sealFileKey` returns `msgKey` raw — the caller owns the lifecycle. The web
client's `doSendFile` and `doReceiveMessage` (file branch) wipe it in a
`try/finally` block. The CLI already does this correctly.

**`InvitePayload` type — named lib export, stripped down.**
`InvitePayload` stays as a named export from the lib. It is the shape that
crosses the parse boundary and flows into the state machine. The join views
in both clients type their local variables and callbacks against it. The
type is:

```ts
export interface InvitePayload {
    version:    number    // populated by parseArmoredInvite; ignored by serializeInvite
    roomId:     string
    roomSecret: string
    dns?:       string
}
```

`serializeInvite` always writes `INVITE_VERSION` unconditionally — it does not
read `version` from the payload. `parseArmoredInvite` populates `version` from
the decoded byte so callers can inspect what they received. This keeps the
version field flexible for future bumps without coupling it to the caller's
construction logic.

**`INVITE_VERSION` constant.**
A named constant in `lib/src/invite.ts` is the single source of truth:

```ts
export const INVITE_VERSION = 0x01
```

`serializeInvite` writes it. `parseArmoredInvite` validates against it.
`makeArmoredInvite` in the state machine passes `version: INVITE_VERSION` when
constructing the payload. Exported from `lib/src/index.ts`.

**Test coverage required before shipping v3.**
- join at epoch N baseline (late joiner receives and decrypts correctly)
- late-joiner-then-ratchet-again (ratchet root consistency)
- multiple late joiners at different epochs
- non-regression: join at epoch 0 identical to v2 behavior
- `removePeer` wipes all state, excludes from subsequent ratchet steps
- `_oldSenderState` pruning: epoch N-3 gone after advancing to N
- `_resolveKey`: all three error cases throw the correct string (already tested)
- `wrapChainSeedFor` called twice for same peer: old root wiped, no leak
- `unwrapChainSeed` called twice for same sender: old chain disposed, old root wiped
- `unwrapChainSeed`: full 36-byte plain buffer wiped (no epoch-prefix residue)
- `doRatchetStep` with empty peers: returns without throwing

---

## what stays from v2

- Sender Keys broadcast model (one send chain per participant, not per pair)
- `performRatchetStep` + `commitRatchetStep` (shared seed for N peers)
- `SkippedKeyStore` and `_oldSenderState` for out-of-order and late-epoch delivery
- `RatchetKeypair` rotation in `receiveRatchetStep`
- `ek_update` wire type for broadcasting new ratchet public keys
- `joined` with `members` array for existing member handshake
- synchronous ratchet path discipline
- no bilateral send chain advance
- no `ratchet_response` / `receiveRatchetResponse`

---

## what changes from v2

**lib/src/session.ts**
- `_currentEpochSeed` field: initialized to `_chainSeed.slice()`, updated in
  `commitRatchetStep`, wiped in `dispose()`
- `_chainSeed` wiped in `commitRatchetStep` after first ratchet step
- `commitRatchetStep` sequence updated (see resolved design questions)
- `wrapChainSeedFor` encrypts `epoch[4] || _currentEpochSeed` not `_chainSeed`;
  calls `ratchetInit(_currentEpochSeed, ...)` not `ratchetInit(_chainSeed, ...)`
- `wrapChainSeedFor` and `unwrapChainSeed` wipe old map entries before overwriting
  (use `.get()` / `.set()` — these are Maps, not plain objects)
- `unwrapChainSeed` blob format: `epoch[4] || seed[32]`; wipes full 36-byte buffer
- `unwrapChainSeed` sets `_senderState` at decoded epoch, not hardcoded 0
- `receiveRatchetStep` prunes `_oldSenderState` entries older than N-2 (done)
- `EPOCH_KEEP_WINDOW = 2` named constant (done)
- `_resolveKey` error messages: future epoch / too old / key not found (done)
- `Session` gains `epoch` and `counter` read-only getters
- `Session` gains `removePeer(username)` method

**lib/src/invite.ts**
- `INVITE_VERSION = 0x01` exported constant
- `ekCreator` removed; `roomSecret: string` added to binary layout
- `authToken` removed from binary layout
- `serializeInvite` writes `INVITE_VERSION` unconditionally; ignores `version` field
- `parseArmoredInvite` validates against `INVITE_VERSION`; populates `version` in result
- Old `.room` files with the v1 binary layout (containing `ekCreator`) will fail
  to decode since offsets have changed; no migration path — pre-release

**lib/src/types.ts**
- `InvitePayload`: remove `ekCreator` and `authToken`; add `roomSecret: string`

**web/src/state.ts and cli/src/state.ts**
- `doCreate` and `doJoin` deduplicated into a shared `doConnect` handler
- `doCreate` sends `join` after `room_created` (creator joins like any other client)
- `makeArmoredInvite(roomId, roomSecret, dns?)` helper; no stored armoredInvite
- `AppState.waiting` and `AppState.ready` carry `roomId`, `roomSecret`, `dns`,
  `username` for reconnect; `armoredInvite` field removed
- `AppState.joining` drops `authToken`; `invite` field simplified
- `doConnect` owns all post-`joined` logic: identify, handshake, message handlers,
  close handler, lobby/ready transitions
- `doConnect` fires `doRatchetStep` (welcome ratchet) after handshake completes;
  this is the only place the welcome ratchet fires
- `doRatchetStep` guards against empty peers with early return
- `joined` with `members = []` → send `identify`, go to lobby (handled in `doConnect`)
- `peer_left`: calls `session.removePeer`; if `peers.size === 0` triggers lobby transition
- lobby transition (situation 3): dispose session, reset counters, fresh keypair,
  send `rekey`, wait for `rekeyed`, render lobby over chat history
- auto-ratchet: check `session.counter >= AUTO_RATCHET_INTERVAL && peers.size > 0`
  in `doSendMessage` and `doSendFile`
- web `doSendFile` and web `doReceiveMessage` (file branch): add `try/finally`
  for `msgKey` wipe (CLI already correct)
- WebSocket close handler covers both `'waiting'` and `'ready'` phases
- web client: remove `IS_CONTAINER`, `CONTAINER_DNS`, `CONTAINER_AUTH` and all
  container-specific code paths; single code path regardless of deployment
- CLI: new `ready → waiting` UI transition (chat → lobby)
- landing screen: "Auth Token" field relabeled "Server Password"; value sent as
  `adminToken` on `create`, not on `join`

**server/src/relay.ts and server/src/index.ts**
- `handleCreate`: generates `roomSecret` (16 Fortuna bytes), validates `adminToken`
  if `ADMIN_TOKEN` env var is set; does NOT add ws to `room.conns`
- `handleJoin`: validates `roomSecret`; `authToken` removed
- `handleRekey`: new handler; checks `ws.data.username !== null`; updates
  `ek` and `ratchetEk` in ConnData; responds `rekeyed`
- `handleClose`: room NOT deleted when `conns.size === 0`
- `lastActivity` timestamp on Room, updated on every message
- Bun cron prunes rooms where `lastActivity > ROOM_TTL && conns.size === 0`
- `/health_check` HTTP route: returns 200 OK

**server/src/rooms.ts**
- `Room` gains `roomSecret: string` and `lastActivity: number` fields

**server/src/types.ts**
- `room_created` gains `roomSecret` field
- `join` requires `roomSecret`, drops `authToken`
- `create` gains optional `adminToken` field
- new inbound: `rekey`
- new outbound: `rekeyed`

**docker / env vars**
- `ADMIN_TOKEN` replaces `AUTH_TOKEN` (gates creation, not joining)
- `ROOM_TTL` new env var (hours, default 24)
- `VITE_AUTH_TOKEN` build arg removed entirely
- `VITE_SERVER_DNS` build arg removed entirely — `DOMAIN` is runtime only
- Dockerfile has zero build args; all configuration is runtime env vars
