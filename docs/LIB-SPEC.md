```
  ▄██▀ ▀█  ▄██▀ █▄  ▀██  ██▀  ▄██▀ ▀█  ▄██▀ █▄   █▄   ▄█
 ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒  ▒▒  ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒▒▄▒▒▒
 ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒▌ ▒▒  ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒ ▀ ▒▒
  ▀██▄ ▄█  ▀██▄ █▀    ▀█▄▀    ▀██▄ ▄█  ▀██▄ █▀  ▄██▄ ▄██▄

XChaCha20 · ML-KEM-768 · Ed25519 · BLAKE3 · SPQR · E2EE · ephemeral · N-party
```

# COVCOM Lib Spec

`@covcom/lib` internals deep-dive. covers the export surface, the session and
identity APIs, invites, file transfer, the protocol manifest, and the shared
text utilities both clients consume.

> [!NOTE]
> This is the API contract for the shared crypto session layer. The protocol
> narrative lives in [PROTOCOL](./PROTOCOL.md); byte layouts, KDF labels, and
> key sizes live in [CRYPTOGRAPHY](./CRYPTOGRAPHY.md). Where this document
> and the leviathan-crypto TypeScript declarations disagree, the declarations
> win; flag the conflict.

> ### Table of Contents
> - [goals](#goals)
> - [module map](#module-map)
> - [export surface](#export-surface)
> - [initialization](#initialization)
> - [keypairs](#keypairs)
> - [session](#session)
>   - [construction](#construction)
>   - [getters](#getters)
>   - [sealing and opening](#sealing-and-opening)
>   - [file keys](#file-keys)
>   - [chain seed handshake](#chain-seed-handshake)
>   - [ratchet step](#ratchet-step)
>   - [peer removal and disposal](#peer-removal-and-disposal)
> - [identity](#identity)
>   - [claims](#claims)
>   - [message signatures](#message-signatures)
>   - [fingerprints](#fingerprints)
> - [invites](#invites)
> - [file transfer](#file-transfer)
> - [protocol manifest](#protocol-manifest)
> - [markup](#markup)
> - [sanitize](#sanitize)
> - [qr](#qr)
> - [key hygiene](#key-hygiene)
> - [testing](#testing)
> - [Cross Reference](#cross-reference)

---

## goals

- the single owner of the `leviathan-crypto` dependency. `web/` and `cli/`
  import only from `@covcom/lib`, never the crypto library directly, so the
  pinned version stays single-sourced and the clients cannot drift onto
  separate WASM instances. `cli/test/crypto-source.test.ts` enforces this.
- a session API, not a raw crypto API. Callers never touch `KDFChain`,
  `Seal`, or `SkippedKeyStore`; they call `sealMessage` and `openMessage`.
- one code path for all room sizes. Two-party rooms are the N=2 case of the
  Sender Keys model; nothing in this package branches on participant count.
- ephemeral by construction. All key material lives in memory, and every
  class exposes a `dispose()` that wipes it.
- shared text plumbing. The markup parser, the display-spoofing sanitizer,
  and the QR encoder live here so both clients render identical results.

---

## module map

```
src/
├── index.ts         the export barrel; the public surface is exactly its exports
├── init.ts          initCrypto(): embedded WASM init, idempotent
├── types.ts         KeyPair, InvitePayload, MessageEnvelope
├── keypair.ts       generateKeypair(): ML-KEM-768 keygen
├── session.ts       Session: sender-keys group state, seal/open, SPQR ratchet
├── identity.ts      SessionIdentity: claims, message signatures, fingerprints
├── invite.ts        serialize, armor, parse, and name .room invites
├── filetransfer.ts  chunk loop, relay tags, file acks, stream re-exports
├── markup.ts        markdown-subset parser to a renderer-agnostic token tree
├── sanitize.ts      bidi and zero-width format-char strip and detect
├── qr.ts            zero-dependency QR module-matrix encoder
├── protocol.ts      PROTOCOL_VERSION, PROTOCOL manifest, CRYPTO_TABLE
└── wipe.ts          re-export of leviathan's wipe
```

---

## export surface

The barrel (`src/index.ts`) defines the public API. Everything below it is
internal.

```ts
export { initCrypto } from './init.js';
export { generateKeypair } from './keypair.js';
export { Session } from './session.js';
export { SessionIdentity } from './identity.js';
export { INVITE_VERSION, serializeInvite, armorInvite, parseArmoredInvite, inviteFilename } from './invite.js';
export { wipe } from './wipe.js';
export { parseMarkup, b, i, bi, code } from './markup.js';
export type { Span, Block, Doc, RichText } from './markup.js';
export { stripFormatChars, hasUnsafeFormatChars } from './sanitize.js';
export type { KeyPair, InvitePayload, MessageEnvelope } from './types.js';
export type { ClaimPayload, FingerprintSurface } from './identity.js';
export { init, SealStream, OpenStream, XChaCha20Cipher, constantTimeEqual } from 'leviathan-crypto';
export type { CipherSuite } from 'leviathan-crypto';
export {
	FILE_CHUNK_SIZE, forEachChunk, WINDOW, ACK_INTERVAL,
	RELAY_TAG_SEED, RELAY_TAG_FILE_ACK,
	prefixTag, readRelayTag, encodeFileAck, decodeFileAck,
} from './filetransfer.js';
export { PROTOCOL, PROTOCOL_VERSION, CRYPTO_TABLE } from './protocol.js';
export { qrMatrix } from './qr.js';
export type { QrOptions } from './qr.js';
```

The `leviathan-crypto` re-exports exist so consumers that need a passthrough
(`SealStream` for file transfer, `constantTimeEqual` for the server's secret
check, `wipe` for client-side teardown) still import from `@covcom/lib` and
the single-owner rule holds.

---

## initialization

```ts
async function initCrypto(): Promise<void>
```

Loads the six embedded WASM modules (`mlkem`, `sha3`, `chacha20`, `sha2`,
`ed25519`, `blake3`) through leviathan's `init`. Idempotent: the second and
later calls return immediately. Both clients call it once at startup
(`web/src/main.ts`, `cli/src/main.ts`) before any other API in this package;
most runtime crypto errors trace back to a missed or reordered init.

The embedded variants bundle the WASM bytes into the JS, which is what lets
the web client stay a single-file SPA and the CLI compile to a standalone
binary with no files on disk.

---

## keypairs

```ts
function generateKeypair(): KeyPair

interface KeyPair {
	ek: Uint8Array // encapsulation key, 1184 bytes (MlKem768)
	dk: Uint8Array // decapsulation key, 2400 bytes (MlKem768)
}
```

Fresh ML-KEM-768 material per call. The temporary `MlKem768` instance is
disposed before returning; only the key bytes escape.

---

## session

`Session` is the per-client room state: one instance per joined room,
constructed after `initCrypto` and disposed on teardown. It implements the
Sender Keys model with the sparse post-quantum ratchet; the narrative is in
[PROTOCOL § the chain](./PROTOCOL.md#the-chain) and
[§ the ratchet](./PROTOCOL.md#the-ratchet), the KDF labels and state table in
[CRYPTOGRAPHY § key derivation chains](./CRYPTOGRAPHY.md#key-derivation-chains).

Every method throws if the session is disposed.

### construction

```ts
constructor(keypair: KeyPair, roomId?: string)
```

Takes ownership of the keypair and draws a fresh 32-byte chain seed. The
optional `roomId` binds the room context into the ratchet KDF, so identical
seeds in different rooms derive unrelated chains. The session starts at epoch
`0`, counter `0`.

### getters

| Getter | Type | Meaning |
| --- | --- | --- |
| `ek` | `Uint8Array` | static ML-KEM-768 encapsulation key, sent in `identify` |
| `ratchetEk` | `Uint8Array` | current ratchet encapsulation key; rotates after each received step |
| `chainSeed` | `Uint8Array` | the 32-byte sending-chain seed; wiped once epoch 0 ends |
| `disposed` | `boolean` | true after `dispose()` |
| `epoch` | `number` | current sending epoch; increments on `commitRatchetStep` |
| `counter` | `number` | sending-chain position; resets to 0 each epoch |
| `identity` | `SessionIdentity` | the per-session identity, created with the session |
| `roomId` | `string` | the bound room context, empty if unset |

### sealing and opening

```ts
sealMessage(plaintext: Uint8Array): { ciphertext: Uint8Array; counter: number; epoch: number }

openMessage(
	senderUsername: string,
	epoch:          number,
	counter:        number,
	ciphertext:     Uint8Array,
): Uint8Array
```

`sealMessage` steps the sending chain once and seals with
XChaCha20-Poly1305; the returned `counter` and `epoch` ride the wire in the
`MessageEnvelope` so receivers can address the matching key. `openMessage`
resolves the key for `(sender, epoch, counter)` and decrypts. Out-of-order
delivery is handled by leviathan's `SkippedKeyStore`; per-peer epoch state
older than the keep window (`EPOCH_KEEP_WINDOW = 2`) is pruned, so a message
from a sufficiently retired epoch throws rather than decrypts.

### file keys

```ts
sealFileKey(): { msgKey: Uint8Array; counter: number; epoch: number }
openFileKey(senderUsername: string, epoch: number, counter: number): ResolveHandle
```

File transfers consume one chain step for the whole stream: `sealFileKey`
steps the sending chain and hands back the raw 32-byte key for a
`SealStream`, sharing the counter space with `sealMessage`. `openFileKey`
returns leviathan's `ResolveHandle` rather than the key directly; the caller
commits the handle after the stream opens cleanly or rolls it back on
failure, so a corrupt transfer does not burn the receive-chain position.

### chain seed handshake

```ts
wrapChainSeedFor(peerEk: Uint8Array, peerUsername: string): Uint8Array
unwrapChainSeed(senderUsername: string, blob: Uint8Array): void
```

The join-time exchange. `wrapChainSeedFor` seals the current epoch seed plus
the sender's epoch number to a peer's static `ek` (ML-KEM-768 encapsulation,
then AEAD) and records the resulting ratchet root for that peer.
`unwrapChainSeed` is the receiving half: it decrypts the blob, initializes
the per-peer receiving chain at the carried epoch, and records the decap
root. Both sides tolerate re-runs for the same peer by wiping the old state
first. The wrapped blob rides a `relay` frame under `RELAY_TAG_SEED`; see
[CRYPTOGRAPHY § chain seed distribution](./CRYPTOGRAPHY.md#chain-seed-distribution).

### ratchet step

A ratchet is a batch: one call per peer, then a single commit.

```ts
updatePeerRatchetEk(peerUsername: string, ek: Uint8Array): void

performRatchetStep(peerUsername: string): {
	kemCt:   Uint8Array
	encSeed: Uint8Array
	pn:      number
}

commitRatchetStep(): void

receiveRatchetStep(
	sender:  string,
	kemCt:   Uint8Array,
	encSeed: Uint8Array,
	pn:      number,
): void
```

`updatePeerRatchetEk` caches the peer's current ratchet key as it arrives
via `peer_joined`, `ratchet_step_fwd`, or `ek_update_fwd`. The initiator
calls `performRatchetStep` once per peer; the first call draws one shared
next-epoch seed for the batch, and each call encapsulates to that peer's
ratchet key and encrypts the shared seed under the resulting chain key. The
returned `{ kemCt, encSeed, pn }` triple is exactly the per-recipient entry
in the `ratchet_step` payloads map, where `pn` is the sending-chain length
at ratchet time so receivers can drain the old epoch. `commitRatchetStep`
then reinitializes the sending chain from the pending seed, increments the
epoch, and resets the counter.

`receiveRatchetStep` is the mirror: decapsulate, decrypt the seed, advance
the old per-peer state to the `pn` boundary and archive it, start the new
epoch's receiving chain, and rotate the local ratchet keypair so the next
step toward this client uses fresh material. Archived epochs beyond the keep
window are pruned.

### peer removal and disposal

```ts
removePeer(username: string): void
dispose(): void
```

`removePeer` wipes and drops every per-peer structure: sender state,
archived epochs, encap and decap roots, the cached ratchet key, and the
peer's identity record. It is a no-op for unknown peers. `dispose` wipes the
static keypair, the seeds, the sending chain, the ratchet keypair, and every
per-peer map, then disposes the identity. Both are idempotent.

---

## identity

`SessionIdentity` owns the per-session Ed25519 keypair and everything built
on it: identity claims, per-message signatures, and the fingerprint surface.
Each `Session` creates one; it shares the session's lifetime and `dispose`
path. The trust narrative is in
[PROTOCOL § identity claims](./PROTOCOL.md#identity-claims); the claim byte
layout is in [CRYPTOGRAPHY § identity claims](./CRYPTOGRAPHY.md#identity-claims).

```ts
class SessionIdentity {
	static create(): SessionIdentity
	get sessionPk(): Uint8Array   // 32-byte Ed25519 public key
	get disposed(): boolean
}
```

Both covcom signing contexts carry the `-v3` suffix, locked to the
leviathan-crypto v3 signing API: `covcom-identity-claim-v3` for claims and
`covcom-message-sig-v3` for messages. They bump in lockstep with the
library's major version, never independently.

### claims

```ts
buildClaim(
	senderKeyPub: Uint8Array,
	username:     string,
	roomId:       string,
	epoch:        number,
): Uint8Array

acceptClaim(senderUsername: string, blob: Uint8Array): ClaimPayload

interface ClaimPayload {
	sessionPk:    Uint8Array
	senderKeyPub: Uint8Array
	username:     string
	sessionId:    Uint8Array
	epoch:        number
	sequenceNum:  number
	issuedAt:     bigint
	prevLogRoot:  Uint8Array
}
```

`buildClaim` encodes a `ClaimPayload` binding the session's signing key to
the sender's KEM key, username, room-derived session ID, and epoch, signs it
as an attached `Sign.sign` envelope, and chains it to the previous local
claim through `prevLogRoot` with an incrementing `sequenceNum`.

`acceptClaim` verifies an incoming envelope. The first claim from a peer
anchors trust-on-first-sight on the claimed `sessionPk`; every later claim
must verify under that same anchored key, continue the sequence without
gaps, and chain its `prevLogRoot` to the previous accepted payload. Each
accepted payload is appended to a per-peer SHA-256 Merkle tree, the
transparency log behind the verify screen. Mismatches throw.

### message signatures

```ts
signMessage(
	counter:    number,
	epoch:      number,
	sender:     string,
	ts:         number,
	ciphertext: Uint8Array,
): Uint8Array

verifyMessage(
	senderUsername: string,
	counter:        number,
	epoch:          number,
	sender:         string,
	ts:             number,
	ciphertext:     Uint8Array,
	sig:            Uint8Array,
): boolean
```

Detached Ed25519 signatures over the canonical encoding of the envelope
metadata plus the ciphertext bytes, so a relayed frame cannot be re-attributed
or re-timestamped without breaking the signature. `verifyMessage` returns
`false` on a bad signature rather than throwing, but throws for an unknown
peer; signature checks happen on every inbound `broadcast` and
`ratchet_step_fwd`.

### fingerprints

```ts
localFingerprint(): FingerprintSurface
peerFingerprint(senderUsername: string): FingerprintSurface | null

interface FingerprintSurface {
	swatches: string[]  // 8 sRGB hex colors
	hex:      string    // 16 lowercase hex chars
	badge:    string    // 1 hex color
}
```

A 16-byte BLAKE3 hash of the session public key, rendered two ways from the
same bytes: eight 16-bit chunks mapped through OKLCh into eight color
swatches, and the raw 16 hex chars for reading aloud. `badge` is the first
swatch, used as the peer's accent color in both clients. `peerFingerprint`
returns `null` for unknown peers. Derivation details live in
[CRYPTOGRAPHY § fingerprint derivation](./CRYPTOGRAPHY.md#fingerprint-derivation).

---

## invites

```ts
const INVITE_VERSION = 0x01;

function serializeInvite(payload: InvitePayload): Uint8Array
function armorInvite(binary: Uint8Array): string
function parseArmoredInvite(text: string): InvitePayload
function inviteFilename(roomId: string): string

interface InvitePayload {
	version:    number    // populated by parseArmoredInvite; ignored by serializeInvite
	roomId:     string
	roomSecret: string    // base64, decodes to 16 raw bytes
	dns?:       string
}
```

The armored `.room` file is the canonical invite, generated and parsed only
here; the server never constructs or reads one. `serializeInvite` throws
`RangeError` unless `roomId` encodes to exactly 32 UTF-8 bytes and
`roomSecret` decodes to exactly 16. `armorInvite` wraps the binary in
`-----BEGIN COVCOM INVITE-----` / `-----END COVCOM INVITE-----` with base64
lines at 64 chars. `parseArmoredInvite` reverses both layers and throws on
missing markers, bad base64, truncation, or an unknown version byte.
`inviteFilename` returns `covcom-${roomId}.room`.

The byte layout is normative in
[CRYPTOGRAPHY § invite encoding](./CRYPTOGRAPHY.md#invite-encoding).

---

## file transfer

Files stream as `broadcast` frames: one `file-begin` carrying the
`SealStream` preamble and metadata, then N `file-chunk` frames each holding
one encrypted chunk. leviathan's `SealStream` and `OpenStream` do the
incremental crypto; this module owns the covcom-side pieces both clients
share.

```ts
const FILE_CHUNK_SIZE = 65536;
const WINDOW          = 64;   // flow-control credit window, in chunks
const ACK_INTERVAL    = 32;   // receiver acks every N chunks

async function forEachChunk(
	read:      (offset: number, len: number) => Promise<Uint8Array>,
	size:      number,
	chunkSize: number,
	cb:        (chunk: Uint8Array, seq: number, final: boolean) => Promise<void> | void,
): Promise<void>
```

`FILE_CHUNK_SIZE` is capped at 65536 because the XChaCha20 WASM seals at
most 65536 plaintext bytes per chunk; `SealStream.push` throws above it.
With base64's 4/3 inflation a frame is roughly 87 KB on the wire, far under
the broker's per-message ceiling. `forEachChunk` drives the seal-and-send
loop over any byte source (`Blob.slice` on web, `Bun.file` slices on cli)
and owns final-chunk detection; a zero-length file still yields exactly one
final empty chunk, so the receiver always sees a terminator.

The sender holds within `WINDOW` chunks of the slowest recipient's last
ack, and each receiver acks every `ACK_INTERVAL` chunks, so the two
constants must divide evenly.

```ts
const RELAY_TAG_SEED     = 0x00;
const RELAY_TAG_FILE_ACK = 0x01;

function prefixTag(tag: number, body: Uint8Array): Uint8Array
function readRelayTag(payload: Uint8Array): { tag: number; body: Uint8Array }
function encodeFileAck(fileId: string, seq: number): Uint8Array
function decodeFileAck(body: Uint8Array): { fileId: string; seq: number }
```

`relay` payloads carry a one-byte tag ahead of the body; the server never
reads it, and a half-applied tag change breaks the chain-seed handshake, not
just file transfer. `decodeFileAck` never throws: malformed acks come back
as the `{ fileId: '', seq: -1 }` sentinel, which matches no transfer.
Tagging is specified in
[CRYPTOGRAPHY § relay payload tagging](./CRYPTOGRAPHY.md#relay-payload-tagging).

---

## protocol manifest

`src/protocol.ts` is the single source of truth for the wire-contract
version and the protocol-identifying display facts. Web, cli, and server all
read from it; re-hardcoding any of these values in a client is the drift
this file exists to prevent.

```ts
export const PROTOCOL_VERSION = 3;

export const PROTOCOL = {
	cipherName: 'XChaCha20-Poly1305',
	kemName: 'ML-KEM-768',
	protocolVersionHex: hex(PROTOCOL_VERSION),  // '0x03'
	autoRatchetEvery: 25,
};

export const CRYPTO_TABLE: readonly (readonly [string, string])[];
```

`PROTOCOL_VERSION` is hand-bumped and deliberately independent of both the
leviathan-crypto version and the `-v3` ctx suffix: the covcom wire contract
can break without a cipher change, and leviathan can bump a format enum
without breaking covcom. `autoRatchetEvery` is the message count that
triggers an automatic ratchet. `CRYPTO_TABLE` is the nine-row component to
primitive table the CLI lobby and the web client both render, so the two
crypto tables cannot disagree. Versioning policy lives in
[PROTOCOL § versioning](./PROTOCOL.md#versioning).

---

## markup

```ts
function parseMarkup(src: string): Doc

type Span =
	| string             // plain text
	| { b: string }      // bold
	| { i: string }      // italic
	| { bi: string }     // bold + italic
	| { code: string };  // inline code

type Block =
	| { p: Span[] }      // a line of inline spans
	| { pre: string };   // fenced block; raw, preserves whitespace/newlines

type Doc = Block[];
type RichText = string | Span[];

const b, i, bi, code: (s: string) => Span
```

The message formatter, shared so both clients parse identically. It turns
untrusted text into a token tree and never builds an HTML string, so there
is no XSS sink; each client owns its renderer (DOM on web, ANSI on cli). The
grammar is small: `*bold*`, `_italic_`, the combined `_*both*_` and
`*_both_*`, single-backtick code, and triple-backtick fences. Code wins over
emphasis, a run of k identical markers contributes one delimiter and k-1
literals, and an unterminated fence falls through to inline parsing instead
of swallowing the rest of the message.

The parser is a hand-written linear scanner, not a backtracking regex, so it
is immune to ReDoS. A defensive cap of 4096 spans per line turns adversarial
marker soup into a single literal tail. `parseMarkup` never throws. The `b`,
`i`, `bi`, and `code` constructors exist for system messages and event-log
summaries, which use the same `RichText` vocabulary.

---

## sanitize

```ts
function stripFormatChars(s: string): string
function hasUnsafeFormatChars(s: string): boolean
```

One shared code-point list covering the Unicode format characters that are
display hazards rather than content: the bidirectional controls
(Trojan-Source-style reordering) and zero-width junk (homoglyph display
names, invisible padding). Stripped: U+061C, U+200B, U+200E, U+200F,
U+202A-U+202E, U+2060, U+2066-U+2069, and U+FEFF. Deliberately kept because
they are legitimate text: ZWNJ and ZWJ (U+200C, U+200D, emoji sequences and
Arabic/Indic joining) and the variation selectors (U+FE00-U+FE0F).

The clients strip untrusted display text with `stripFormatChars`; the server
rejects usernames containing any listed code point via
`hasUnsafeFormatChars`, the same list through the same export, so the relay
and the client sanitizer cannot drift.

---

## qr

```ts
function qrMatrix(data: string, opts: QrOptions = {}): boolean[][]

interface QrOptions {
	version?: number;  // 1-10, auto-selected if unset
	mask?:    number;  // 0-7, auto-selected if unset
}
```

A zero-dependency QR encoder scoped to exactly what invites need: byte mode,
error-correction level L, versions 1 through 10. It returns a raw module
matrix (`true` is dark); rendering lives with each client (half-block glyphs
on cli, SVG on web). Armored invites land around versions 6 to 8; payloads
beyond the version 10 capacity (271 bytes at level L) throw `RangeError` so
the caller can hide the QR pane instead of rendering garbage. The pipeline
is the standard flow from ISO/IEC 18004 (Information technology, automatic
identification, QR Code bar code symbology specification).

---

## key hygiene

Nothing in this package writes key material anywhere but memory. The
contract, enforced by tests:

- `Session.dispose()` wipes the static keypair, both seeds, the sending
  chain, the ratchet keypair, every per-peer root and chain, and disposes
  the identity. Idempotent.
- `SessionIdentity.dispose()` wipes the signing key, the local claim-chain
  hash, and every peer record. Idempotent.
- `removePeer` wipes before it deletes, on both classes.
- transient secrets (the chain seed after epoch 0, a pending ratchet seed
  after commit, superseded roots on re-handshake) are wiped at the moment
  they stop being needed, not just at teardown.

The clients hook these into their teardown paths (disconnect, unload,
signal); the rationale and the full state inventory live in
[CRYPTOGRAPHY § key hygiene](./CRYPTOGRAPHY.md#key-hygiene) and
[§ session state](./CRYPTOGRAPHY.md#session-state).

---

## testing

`bun test:lib` runs the suite; each file pins one module's contract.

| File | Pins |
| --- | --- |
| `test/session.test.ts` | seal/open round-trips, out-of-order delivery and skip ceilings, N=2 and N=5 group flows, batched ratchet steps, epoch keep-window pruning, room-context chain separation, late-join sync, `ResolveHandle` commit/rollback, dispose wiping |
| `test/identity.test.ts` | claim round-trips, trust-on-first-sight anchoring, sequence and `prevLogRoot` continuity, forgery rejection, message sign/verify, fingerprint shape and determinism |
| `test/invite.test.ts` | serialize/armor/parse round-trips, armor line format, version and truncation rejection, the 32-byte roomId and 16-byte secret rules, filename format |
| `test/filetransfer.test.ts` | chunk loop semantics including the zero-byte case, stream round-trips at `FILE_CHUNK_SIZE`, tag round-trips, ack encode/decode and the defensive sentinel, `WINDOW`/`ACK_INTERVAL` divisibility |
| `test/protocol.test.ts` | `CRYPTO_TABLE` rows and ordering, manifest consistency, the zero-padded version hex |
| `test/keypair.test.ts` | ML-KEM-768 key sizes, freshness across calls |
| `test/markup.test.ts` | the grammar, surplus-marker handling, code-wins, fence behavior, literal HTML passthrough |
| `test/sanitize.test.ts` | the strip and keep lists |
| `test/qr.test.ts` | fixture parity with a reference encoder, version auto-selection, the capacity `RangeError` |
| `test/wipe.test.ts` | in-place zeroing, view-only scope, idempotence |

---

## Cross Reference

| Document | Description |
| -------- | ----------- |
| [index](./README.md) | Project Documentation index |
| [USAGE](./USAGE.md) | Client and server applications development and runtime help |
| [PROTOCOL](./PROTOCOL.md) | Cipher, chains, ratchet, group model, session lifecycle, server role |
| [CRYPTOGRAPHY](./CRYPTOGRAPHY.md) | Primitives, KDF chains, wire format, invite encoding |
| [THREAT-MODEL](./THREAT-MODEL.md) | Principals, adversary tiers, guarantees, non-goals |
| [SERVER-SPEC](./SERVER-SPEC.md) | Server wire contract, message handlers, room lifecycle, and configuration |
| [WEB-SPEC](./WEB-SPEC.md) | Web client architecture, state and session model, views, rendering, and the single-file build |
| [CLI-SPEC](./CLI-SPEC.md) | CLI architecture, rendering, input, widgets, views, and color system |
| [TESTING](./TESTING.md) | Test layers, unit and end-to-end suites, cross-client interop, and CI |
