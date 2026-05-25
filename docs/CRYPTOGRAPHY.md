```
  ▄██▀ ▀█  ▄██▀ █▄  ▀██  ██▀  ▄██▀ ▀█  ▄██▀ █▄   █▄   ▄█
 ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒  ▒▒  ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒▒▄▒▒▒
 ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒▌ ▒▒  ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒ ▀ ▒▒
  ▀██▄ ▄█  ▀██▄ █▀    ▀█▄▀    ▀██▄ ▄█  ▀██▄ █▀  ▄██▄ ▄██▄

XChaCha20 · ML-KEM-768 · SPQR · E2EE · ephemeral · N-party
```

# COVCOM Cryptography Reference

> [!NOTE]
> A technical reference for auditors. Covers primitives, key derivation
> chains, session state, wire format, and invite encoding. For narrative
> context see [PROTOCOL](./PROTOCOL.md). For the adversary
> model see [THREAT-MODEL](./THREAT-MODEL.md).

> ### Table of Contents
> - [primitive set](#primitive-set)
> - [key derivation chains](#key-derivation-chains)
> - [session state](#session-state)
> - [message encryption](#message-encryption)
> - [ratchet step](#ratchet-step)
> - [chain seed distribution](#chain-seed-distribution)
> - [wire format](#wire-format)
> - [invite encoding](#invite-encoding)
> - [key hygiene](#key-hygiene)

---

## primitive set

All primitives are provided by [leviathan-crypto][LC].

| Primitive | Parameters | Use |
|---|---|---|
| [XChaCha20-Poly1305][LC-CHACHA] | 256-bit key, 192-bit nonce | Message and file AEAD |
| [ML-KEM-768][LC-MLKEM] | FIPS 203, security level 3 | KEM ratchet, chain seed distribution |
| [HKDF-SHA-256][LC-SHA2] | RFC 5869 | All key derivation |
| [Seal+MlKemSuite][LC-AEAD] | ML-KEM-768 + XChaCha20-Poly1305 | Chain seed relay blobs |
| [SealStreamPool][LC-AEAD] | XChaCha20-Poly1305, 65536-byte chunks | File attachments |
| [Fortuna CSPRNG][LC-FORTUNA] | 32 entropy pools | Room secret generation |

No third-party cryptographic dependencies. No WebCrypto. All operations run
through leviathan-crypto's TypeScript/WASM layer.

---

## key derivation chains

Three HKDF-SHA-256 functions drive the ratchet. Info strings include the
room ID as a context suffix for domain separation across rooms.

### KDF_SCKA_INIT (session initialization)

Maps to `ratchetInit(sk, context?)` ([§5.4][S54]).

```
salt:   0x00 × 32
ikm:    sk  (32-byte shared chain seed)
info:   'leviathan-ratchet-v1 Chain Start'  (32 bytes) [|| roomId]
length: 96 bytes
output: rootKey (32) || sendCK (32) || recvCK (32)
```

Both parties call this with the same seed and independently derive identical
chain keys. No further communication is needed to synchronize.

### KDF_SCKA_CK (per-message chain step)

Maps to `KDFChain.step()` ([§2.2][S22]).

```
salt:   0x00 × 32
ikm:    ck  (current 32-byte chain key)
info:   'leviathan-ratchet-v1 Chain Step'  (31 bytes) || counter (uint64be)
length: 64 bytes
output: nextCK (32) || msgKey (32)
```

The counter is a monotonically increasing uint64 encoded big-endian. The old
chain key is wiped before the new one is stored. `msgKey` is wiped after use.
Calling `step()` after `dispose()` throws.

### KDF_SCKA_RK (KEM epoch ratchet)

Maps to `kemRatchetEncap` / `kemRatchetDecap` ([§7.2][S72]).

```
salt:   rk  (current 32-byte root key)
ikm:    kemSS  (ML-KEM-768 shared secret, 32 bytes)
info:   'leviathan-ratchet-v1 Chain Add Epoch'  (36 bytes) [|| roomId]
length: 96 bytes
output: nextRootKey (32) || sendCK (32) || recvCK (32)
```

The encapsulator produces `kemCt` (1088 bytes). The decapsulator recovers
`kemSS` from `kemCt` using their private ratchet key. Both sides derive the
same 96-byte output. Direction is handled by slot renaming in `kemRatchetDecap`
so `alice.sendCK === bob.recvCK`.

---

## session state

Per-participant state held in `lib/src/session.ts`:

| Field | Type | Description |
|---|---|---|
| `_ek / _dk` | Seal keypair | Encapsulation key for receiving chain seeds |
| `_kp` | RatchetKeypair | ML-KEM-768 keypair for KEM ratchet steps |
| `_chainSeed` | 32 bytes | Initial seed; wiped after first ratchet |
| `_currentEpochSeed` | 32 bytes | Current epoch seed for late-joiner relay |
| `_myChain` | KDFChain | Send chain |
| `_myEpoch` | uint32 | Current send epoch |
| `_encapRoots` | Map<username, 32B> | Per-peer root keys (encap direction) |
| `_decapRoots` | Map<username, 32B> | Per-peer root keys (decap direction) |
| `_senderState` | Map<username, {chain, epoch, store}> | Receive chains per sender |
| `_oldSenderState` | Map<username, Map<epoch, state>> | Pruned past epochs |
| `_peerRatchetEks` | Map<username, bytes> | Peer current ratchet public keys |
| `_roomCtx` | bytes | Room ID as HKDF context |

`EPOCH_KEEP_WINDOW = 2`: keeps current epoch plus two previous (N, N-1, N-2).
One wider than Signal §5.7 for out-of-order tolerance.

`MAX_SKIP`: ceiling on `SkippedKeyStore` entries per sender per epoch.

---

## message encryption

`sealMessage(plaintext)`:

1. `KDFChain.step()` → `msgKey` (32 bytes), advances chain
2. `Seal.encrypt(XChaCha20Cipher, msgKey, plaintext)` → ciphertext
3. `wipe(msgKey)`
4. Return `{ epoch, counter, ciphertext }`

`openMessage(sender, epoch, counter, ciphertext)`:

1. `_resolveKey(sender, epoch, counter)` → `msgKey`
   - Current epoch: step chain to counter, store skipped keys up to `MAX_SKIP`
   - Previous epoch (≤ N-2): look up `_oldSenderState`
   - Skipped key: retrieve from `SkippedKeyStore`, delete entry
2. `Seal.decrypt(XChaCha20Cipher, msgKey, ciphertext)` → plaintext
3. `wipe(msgKey)`

File attachments: `sealFileKey()` returns a single-use 32-byte key. The caller
encrypts via `SealStreamPool` (65536-byte chunks, parallel WASM workers) and
wipes the key in a `try/finally` block.

---

## ratchet step

`performRatchetStep(peerUsername)` is called once per peer in a batch:

1. `kemRatchetEncap(MlKem768, _encapRoots[peer], _peerRatchetEks[peer], _roomCtx)`
   → `{ nextRootKey, sendCK, recvCK, kemCt }`
2. `encSeed = Seal.encrypt(XChaCha20Cipher, sendCK, _pendingRatchetSeed)`
3. `wipe(sendCK)`
4. `_encapRoots[peer] = nextRootKey`
5. Return `{ kemCt, encSeed, pn: _myChain.n }`

One 32-byte `_pendingRatchetSeed` is shared across all peers in the batch. Each
peer receives a distinct `kemCt` but the same seed once decapsulated. This
gives O(N) state for N-party sessions.

`commitRatchetStep()`:

1. `_myChain.dispose()`
2. `_myChain = new KDFChain(_pendingRatchetSeed)`
3. `_myEpoch++`
4. `_currentEpochSeed = _pendingRatchetSeed.slice()`
5. `wipe(_pendingRatchetSeed)`
6. `wipe(_chainSeed)`

`receiveRatchetStep(sender, kemCt, encSeed, pn)`:

1. `kemRatchetDecap(MlKem768, _decapRoots[sender], _kp.dk, kemCt, _roomCtx)`
   → `{ nextRootKey, sendCK, recvCK }`
2. `newSeed = Seal.decrypt(XChaCha20Cipher, recvCK, encSeed)`
3. `wipe(recvCK)`
4. Archive old sender chain at `_oldSenderState[sender][oldEpoch]`
5. `SkippedKeyStore.advanceToBoundary(oldChain, pn)`
6. Prune `_oldSenderState[sender]` entries older than `currentEpoch - EPOCH_KEEP_WINDOW`
7. `_senderState[sender] = { chain: new KDFChain(newSeed), epoch: newEpoch }`
8. `_kp.dispose()` then `_kp = new RatchetKeypair()`

`RatchetKeypair.decap()` wipes `dk` in a `try/finally` block immediately after
use (F-02 fix). Each keypair decapsulates exactly once.

Auto-ratchet fires on the client's send path (web client
`CovcomSession.sendMessage`/`sendFile`, CLI `doSendMessage`/`doSendFile`)
when `session.counter >= AUTO_RATCHET_INTERVAL` (25) and there is at
least one peer in the room. It does not fire inside `sealMessage` because
that would recurse.

---

## chain seed distribution

Relay blob plaintext: `epoch[4 LE] || seed[32]` = 36 bytes.

`wrapChainSeedFor(peerEk, username)`:
- `Seal.encrypt(MlKemSuite, peerEk, epoch[4LE] || _currentEpochSeed)`
- Wipes old map entry before overwrite
- Sends as `relay` wire message to peer

`unwrapChainSeed(senderUsername, blob)`:
- `Seal.decrypt(MlKemSuite, _dk, blob)` → 36-byte plain
- Reads `epoch` from bytes 0-3 (little-endian uint32)
- `ratchetInit(seed, _roomCtx)` → root key, sendCK, recvCK
- Sets `_senderState[sender]` at decoded epoch (not hardcoded 0)
- Wipes the full 36-byte plain buffer

---

## wire format

All WebSocket messages are JSON with a `type` field. Full type definitions
in `server/src/types.ts`.

**Inbound (client → server)**

| Type | Key fields | Description |
|---|---|---|
| `create` | `adminToken?` | Create a room |
| `join` | `roomId`, `roomSecret` | Join a room |
| `identify` | `username`, `ek`, `ratchetEk`, `claim` | Announce identity after join with signed claim |
| `relay` | `to`, `payload` | Send chain seed to a peer (base64) |
| `broadcast` | `payload`, `meta`, `sig` | Send encrypted message with detached signature |
| `ratchet_step` | `payloads{}`, `newEk`, `payload`, `meta`, `sig`, `claim` | Fan-out ratchet step with continuation claim |
| `ek_update` | `ek`, `claim` | Broadcast new encapsulation key post-ratchet |
| `rekey` | `ek`, `ratchetEk` | Update keys in lobby without peer_joined |

**Outbound (server → client)**

| Type | Key fields | Description |
|---|---|---|
| `room_created` | `roomId`, `roomSecret` | Server confirmation of room creation |
| `joined` | `members[]` | Room joined; member list with public keys and claims |
| `peer_joined` | `username`, `ek`, `ratchetEk`, `claim` | New peer announced with signed identity claim |
| `peer_left` | `username` | Peer disconnected |
| `relay` | `from`, `payload` | Forwarded chain seed blob |
| `broadcast` | `from`, `payload`, `meta`, `sig` | Forwarded encrypted message with signature |
| `ratchet_step_fwd` | `from`, `kemCt`, `encSeed`, `pn`, `newEk`, `payload`, `meta`, `sig`, `claim` | Per-peer ratchet step delivery |
| `ek_update_fwd` | `from`, `ek`, `claim` | Forwarded ek update with continuation claim |
| `rekeyed` | n/a | Server acknowledgement of `rekey` |
| `error` | `reason` | `room_full` \| `not_found` \| `forbidden` \| `username_taken` |

`ratchet_step` carries both key material and the first encrypted message of the
new epoch. The `payload` field is a `sealMessage` ciphertext at `newEpoch`.
Receivers decrypt it after applying the ratchet step.

`meta` on `broadcast` and `ratchet_step` is a `MessageEnvelope`:
`{ epoch: number, counter: number, ... }`.

The `claim` and `sig` fields are base64-encoded outputs from
leviathan-crypto v3's `Sign` API. `claim` is an attached envelope; `sig`
is a detached signature. The server forwards both opaquely without
inspection.

---

## identity claims

Identity claims are signed with `Ed25519PreHashSuite` (formatEnum `0x11`,
suite `ctxDomain` `ed25519-prehash-envelope-v3`) per
leviathan-crypto v3. The covcom layer carries a user ctx of
`covcom-identity-claim-v3`. The wire envelope is the standard
attached form documented in the leviathan-crypto signing docs:

```
offset           length  field
0                1       suite_byte (0x11)
1                1       ctx_len    (24)
2                24      user_ctx   ("covcom-identity-claim-v3")
26               4       payload_len (u32 BE)
30               N       payload (binary, layout below)
30 + N           64      Ed25519ph signature
```

**Claim payload binary layout (variable length).**

```
offset                  length  field
0                       32      sessionPk      (Ed25519 session signing pk)
32                      2       senderKeyLen   (u16 BE, length of senderKeyPub)
34                      K       senderKeyPub   (raw current ML-KEM-768 ratchet ek, 1184 bytes)
34 + K                  1       usernameLen    (uint8, 1-255)
35 + K                  L       username       (UTF-8, len = usernameLen)
35 + K + L              16      sessionId      (UTF-8 of roomId, truncated or right-padded with 0x00)
51 + K + L              4       epoch          (u32 BE)
55 + K + L              4       sequenceNum    (u32 BE, per-sender monotonic)
59 + K + L              8       issuedAt       (u64 BE, milliseconds since unix epoch)
67 + K + L              32      prevLogRoot    (BLAKE3 of prior claim payload, or 32 zeros for first)
```

Total payload size is `99 + K + L` bytes, around `99 + 1184 + 8 = 1291`
bytes for an ML-KEM-768 ratchet ek and an 8-character username. The full
signed envelope adds 94 bytes of framing for a typical total around 1385
bytes. The variable-length senderKeyPub field carries the raw ratchet ek
so receivers can compare against the value they see in `peer_joined` or
`ek_update_fwd` directly.

**Per-message signatures** are detached signatures over the byte string

```
counter(u32 BE) || epoch(u32 BE) || senderLen(u8) || sender(UTF-8) || ts(u64 BE) || ciphertext
```

signed under the ctx `covcom-message-sig-v3`. The signature is exactly
64 bytes raw, base64-encoded for transport in the wire `sig` field.

**Chain continuity.** A receiver maintains per-other-sender state of
`{ sessionPk, lastSeq, lastPayloadHash, sha256Tree }`. On receiving a
claim from a known peer, the receiver asserts:

- `payload.sessionPk` equals the stored peer `sessionPk`
- `payload.sequenceNum == lastSeq + 1`
- `payload.prevLogRoot == BLAKE3.hash(prior payload bytes)`

then appends the new payload to the per-sender SHA-256 Merkle tree and
updates the per-peer state. The very first claim from a peer
self-attests: the receiver extracts the session pk from the payload to
verify the signature, then records the pk as the canonical identity for
that sender along with the claim's sequence number as the continuity
baseline. The first claim is trust-on-first-sight and may carry any
sequence number, because a late joiner cannot have witnessed the peer's
earlier claims. Continuity is enforced forward from the observed
baseline, not back to sequence zero.

---

## fingerprint derivation

Both the per-user ambient badge and the out-of-band verification color
row derive from `BLAKE3.hash(sessionPk, 16)`. The 16-byte digest splits
into eight 16-bit chunks (big-endian). Each chunk maps to a sRGB hex
color through this pipeline:

1. Split the chunk into a high 8-bit hue index and a low 8-bit lightness
   index.
2. Hue radians: `h = (hueBits / 256) * 2π`.
3. Lightness: `L = 0.30 + (lightBits / 255) * 0.55` (range 0.30 to 0.85).
4. Fixed chroma: `C = 0.15`.
5. OKLab components: `a = C*cos(h)`, `b = C*sin(h)`.
6. OKLab to linear sRGB via the standard matrix (Björn Ottosson, "A
   perceptual color space for image processing", 2020).
7. Linear sRGB to sRGB via the IEC 61966-2-1 gamma function.
8. Clamp each channel to `[0, 1]`, multiply by 255, round, render as
   `#rrggbb`.

The OKLCh remap keeps adjacent bit values visually distinct on commodity
displays. Raw RGB565 to sRGB nearest-neighbor mapping would produce
imperceptible color steps in some hue regions, which would defeat the
purpose.

The ambient badge color uses only the first 16 bits of the digest. The
verification row uses all 128 bits across eight swatches, giving a
128-bit second-preimage budget against fingerprint forgery. A 16-byte
hex fallback (the first 8 bytes of the same digest, lowercase) is always
available for accessibility (color-blindness, screen calibration drift,
cross-device verification by phone).

---

## invite encoding

Binary layout, minimum 49 bytes:

```
offset  len   field
0       1     INVITE_VERSION (0x01)
1       32    roomId (UTF-8 hex string, exactly 32 bytes)
33      16    roomSecret (raw random bytes)
49      var   dns (UTF-8 string, optional)
```

`roomSecret` is 16 bytes of Fortuna CSPRNG output, server-generated at room
creation. Never transmitted in plaintext outside the invite blob.

Armored format:

```
-----BEGIN COVCOM INVITE-----
<base64 of binary blob>
-----END COVCOM INVITE-----
```

Invite files use the naming convention `covcom-${roomId}.room`.

`parseArmoredInvite` validates `INVITE_VERSION`. Old invite files with
different armor headers or binary layouts are rejected; no migration path.

---

## key hygiene

| Material | Wipe trigger |
|---|---|
| `KDFChain` chain key | Before each replacement in `step()` |
| Message key (`msgKey`) | After AEAD operation, `try/finally` |
| `RatchetKeypair.dk` | After `decap()`, `try/finally` |
| `_pendingRatchetSeed` | In `commitRatchetStep()` after `KDFChain` construction |
| `_chainSeed` | In `commitRatchetStep()` after first ratchet |
| `sendCK` from `kemRatchetEncap` | After `Seal.encrypt(encSeed)` |
| `recvCK` from `kemRatchetDecap` | After `Seal.decrypt(encSeed)` |
| `kemSS` in `kemRatchetEncap/Decap` | Inside leviathan-crypto, before return |
| 36-byte relay plain buffer | After `unwrapChainSeed` extracts seed |
| File `msgKey` | `try/finally` in the client's send and receive paths |
| Full session | On WebSocket close, tab unload, SIGTERM |

`wipe()` zeroes the buffer in-place. Wiped buffers are not reused.

---

[LC]:          https://github.com/xero/leviathan-crypto
[LC-AEAD]:     https://github.com/xero/leviathan-crypto/wiki/aead
[LC-CHACHA]:   https://github.com/xero/leviathan-crypto/wiki/chacha20
[LC-MLKEM]:    https://github.com/xero/leviathan-crypto/wiki/mlkem
[LC-SHA2]:     https://github.com/xero/leviathan-crypto/wiki/sha2
[LC-FORTUNA]:  https://github.com/xero/leviathan-crypto/wiki/fortuna
[RFC5869]:     https://datatracker.ietf.org/doc/html/rfc5869
[RFC8439]:     https://datatracker.ietf.org/doc/html/rfc8439
[FIPS203]:     https://csrc.nist.gov/pubs/fips/203/final
[S22]:         https://signal.org/docs/specifications/doubleratchet/#symmetric-key-ratchet
[S54]:         https://signal.org/docs/specifications/doubleratchet/#spqr-initialization
[S72]:         https://signal.org/docs/specifications/doubleratchet/#recommended-cryptographic-algorithms
