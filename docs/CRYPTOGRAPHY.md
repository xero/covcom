# COVCOM Cryptography Reference

> [!NOTE]
> A technical reference for auditors. Covers primitives, key derivation
> chains, session state, wire format, and invite encoding. For narrative
> context see [./PROTOCOL.md](./PROTOCOL.md). For the adversary
> model see [./THREAT-MODEL.md](./THREAT-MODEL.md).

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
| [ML-KEM-768][LC-KYBER] | FIPS 203, security level 3 | KEM ratchet, chain seed distribution |
| [HKDF-SHA-256][LC-SHA2] | RFC 5869 | All key derivation |
| [Seal+KyberSuite][LC-AEAD] | ML-KEM-768 + XChaCha20-Poly1305 | Chain seed relay blobs |
| [SealStreamPool][LC-AEAD] | XChaCha20-Poly1305, 65536-byte chunks | File attachments |
| [Fortuna CSPRNG][LC-FORTUNA] | 32 entropy pools | Room secret generation |

No third-party cryptographic dependencies. No WebCrypto. All operations run
through leviathan-crypto's TypeScript/WASM layer.

---

## key derivation chains

Three HKDF-SHA-256 functions drive the ratchet. Info strings include the
room ID as a context suffix for domain separation across rooms.

### KDF_SCKA_INIT — session initialization

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

### KDF_SCKA_CK — per-message chain step

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

### KDF_SCKA_RK — KEM epoch ratchet

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

`performRatchetStep(peerUsername)` — called once per peer in a batch:

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

Auto-ratchet fires in `doSendMessage` and `doSendFile` when
`session.counter >= AUTO_RATCHET_INTERVAL` (25) and `peers.size > 0`.
It does not fire inside `sealMessage` (would cause infinite recursion).

---

## chain seed distribution

Relay blob plaintext: `epoch[4 LE] || seed[32]` = 36 bytes.

`wrapChainSeedFor(peerEk, username)`:
- `Seal.encrypt(KyberSuite, peerEk, epoch[4LE] || _currentEpochSeed)`
- Wipes old map entry before overwrite
- Sends as `relay` wire message to peer

`unwrapChainSeed(senderUsername, blob)`:
- `Seal.decrypt(KyberSuite, _dk, blob)` → 36-byte plain
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
| `identify` | `username`, `ek`, `ratchetEk` | Announce identity after join |
| `relay` | `to`, `payload` | Send chain seed to a peer (base64) |
| `broadcast` | `payload`, `meta` | Send encrypted message to all peers |
| `ratchet_step` | `payloads{}`, `newEk`, `payload`, `meta` | Fan-out ratchet step |
| `ek_update` | `ek` | Broadcast new encapsulation key post-ratchet |
| `rekey` | `ek`, `ratchetEk` | Update keys in lobby without peer_joined |

**Outbound (server → client)**

| Type | Key fields | Description |
|---|---|---|
| `room_created` | `roomId`, `roomSecret` | Server confirmation of room creation |
| `joined` | `members[]` | Room joined; member list with current public keys |
| `peer_joined` | `username`, `ek`, `ratchetEk` | New peer announced to room |
| `peer_left` | `username` | Peer disconnected |
| `relay` | `from`, `payload` | Forwarded chain seed blob |
| `broadcast` | `from`, `payload`, `meta` | Forwarded encrypted message |
| `ratchet_step_fwd` | `from`, `kemCt`, `encSeed`, `pn`, `newEk`, `payload`, `meta` | Per-peer ratchet step delivery |
| `ek_update_fwd` | `from`, `ek` | Forwarded ek update |
| `rekeyed` | — | Server acknowledgement of `rekey` |
| `error` | `reason` | `room_full` \| `not_found` \| `forbidden` \| `username_taken` |

`ratchet_step` carries both key material and the first encrypted message of the
new epoch. The `payload` field is a `sealMessage` ciphertext at `newEpoch`.
Receivers decrypt it after applying the ratchet step.

`meta` on `broadcast` and `ratchet_step` is a `MessageEnvelope`:
`{ epoch: number, counter: number, ... }`.

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
| File `msgKey` | `try/finally` in `doSendFile` / `doReceiveMessage` |
| Full session | On WebSocket close, tab unload, SIGTERM |

`wipe()` zeroes the buffer in-place. Wiped buffers are not reused.

---

[LC]:          https://github.com/xero/leviathan-crypto
[LC-AEAD]:     https://github.com/xero/leviathan-crypto/wiki/aead
[LC-CHACHA]:   https://github.com/xero/leviathan-crypto/wiki/chacha20
[LC-KYBER]:    https://github.com/xero/leviathan-crypto/wiki/kyber
[LC-SHA2]:     https://github.com/xero/leviathan-crypto/wiki/sha2
[LC-FORTUNA]:  https://github.com/xero/leviathan-crypto/wiki/fortuna
[RFC5869]:     https://datatracker.ietf.org/doc/html/rfc5869
[RFC8439]:     https://datatracker.ietf.org/doc/html/rfc8439
[FIPS203]:     https://csrc.nist.gov/pubs/fips/203/final
[S22]:         https://signal.org/docs/specifications/doubleratchet/#symmetric-key-ratchet
[S54]:         https://signal.org/docs/specifications/doubleratchet/#spqr-initialization
[S72]:         https://signal.org/docs/specifications/doubleratchet/#recommended-cryptographic-algorithms
