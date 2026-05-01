# COVCOM

**COVCOM**: covert communications for private group conversations. Share an invite, talk, close the tab, and it's gone. End-to-end encrypted with post-quantum cryptography, so the messages stay private today and unreadable to the computers coming tomorrow.

> [!NOTE]
> A technical overview of COVCOM: how the encryption works, how the server
> stays ignorant, and where the design makes deliberate tradeoffs.

> ### Table of Contents
> - [the cipher](#the-cipher)
> - [the chain](#the-chain)
> - [the ratchet](#the-ratchet)
> - [group messaging](#group-messaging)
> - [joining a room](#joining-a-room)
> - [session lifecycle](#session-lifecycle)
> - [the server](#the-server)
> - [the clients](#the-clients)
> - [security properties](#security-properties)
> - [honest limitations](#honest-limitations)

---

## the cipher

COVCOM encrypts every message with [XChaCha20-Poly1305][RFC8439]. That is the
foundation. The post-quantum KEM, the double ratchet, and the epoch
machinery are all built around a single purpose: getting a fresh, unique
XChaCha20 key to the right people at the right time.

XChaCha20 is fast, audited, and carries a 192-bit nonce space that makes
accidental nonce reuse practically impossible regardless of message volume.
Poly1305 authenticates every ciphertext, so a garbled or tampered message
fails authentication before any plaintext is produced. Each message key is
used exactly once, then wiped.

File attachments use the same cipher through `SealStreamPool`, a chunked
streaming wrapper that splits payloads into 65 KB frames and processes them
in parallel across worker threads. The file key comes from the same chain as
regular message keys and travels in the broadcast metadata, never in
plaintext.

---

## the chain

Each participant owns one send chain. It is stateful and forward-secret,
implemented as a `KDFChain` from the [leviathan-crypto ratchet module][LC-PR12].

Every call to `step()` runs [HKDF-SHA-256][RFC5869] over the current chain key with a
big-endian uint64 counter in the info bytes, producing a new chain key and a
fresh 32-byte message key. The old chain key is wiped before the new one is
stored. Calling `step()` on an already-disposed chain throws; the stateful
design makes reuse structurally impossible.

This is the symmetric-key ratchet from the Double Ratchet spec ([§2.2][S22]).
Because message keys are not used to derive anything else, you can delete a
key the moment you finish with it without affecting any other message's
security. A device compromised after a conversation ends cannot reconstruct
the XChaCha20 keys that protected it.

Out-of-order delivery is handled by `SkippedKeyStore`, which advances the
chain past gaps while caching keys for messages that may still arrive. A
ceiling on cached keys prevents a malicious sender from forcing unbounded
storage growth ([§2.6][S26]).

---

## the ratchet

A chain that never refreshes only solves half the problem. If someone
compromises a chain key today, they can decrypt every future message in that
chain until someone catches on. The ratchet limits that window by
periodically generating a new chain seed from fresh cryptographic material.

The Double Ratchet algorithm was originally published as the Axolotl Ratchet
in 2013 — named for the Mexican salamander famous for regenerating lost
limbs. The name fits: compromise a key, the next ratchet step heals it. The
[rename to Double Ratchet][DR-RENAME] happened before the first public spec
release, but the regeneration metaphor stuck.

Classic Signal uses Diffie-Hellman for the ratchet step. Each party
publishes a new ephemeral public key with every message, and the DH output
mixes into the root key, refreshing the chain. Both parties can compute the
shared output simultaneously, so classic DR ratchets on every exchange.

COVCOM uses ML-KEM-768 (Kyber, [FIPS 203][FIPS203]) instead. ML-KEM is a
Key Encapsulation Mechanism: the encapsulator generates a fresh ciphertext
and shared secret in one operation; the decapsulator recovers the same
secret from the ciphertext. That shared secret feeds into root key
derivation via HKDF-SHA-256 (`KDF_SCKA_RK`, [§7.2][S72]), expanding to 96
bytes of output: a new root key, a new send chain key, and a new receive
chain key, all derived in one pass.

The reason for 96 bytes rather than the classic 64 is that one KEM epoch
spawns both the send chain and the receive chain simultaneously. In classic
DR, a DH step spawns one new chain at a time because it requires two DH
exchanges in alternation. ML-KEM is non-interactive on the encapsulator's
side, so both chains can emerge from a single operation.

The asymmetry of ML-KEM changes how the ratchet behaves. In classic DH,
both parties can advance independently from their own computation. With
ML-KEM, the encapsulator goes first; the decapsulator cannot advance until
the KEM ciphertext arrives in a message header. This is why the protocol is
a Sparse Post-Quantum Ratchet ([§5][S5]): you cannot ratchet on every single
message because the KEM ciphertext for ML-KEM-768 is 1088 bytes, and that
overhead on every message would be impractical.

Three events trigger a ratchet: a new participant joining the room, a user
pressing the rotate button manually, and an automatic trigger after every 25
messages sent. At 25 messages the per-sender post-compromise security window
is short at normal chat pace, and the cost is roughly one ML-KEM encap per
peer (about 0.13 ms each, benchmarked in the sandbox). The overhead is
invisible to the user.

When a ratchet fires, the `ratchet_step` wire message carries both the key
material and the first encrypted message of the new epoch. Each peer gets
their own `kemCt`, a shared `encSeed` encrypted with the KEM-derived
symmetric key, and the sender's new ratchet public key. After a receiver
decapsulates, their own ratchet keypair rotates and they broadcast the
replacement via `ek_update`. The keypair that just decapsulated is gone.

---

## group messaging

Per-pair ratchet channels require O(N²) state in a group. A 10-person room
would mean 90 distinct channel states, each consuming memory and requiring
coordination. The state grows quadratically with participants.

COVCOM uses the Sender Keys model instead ([WhatsApp Security Whitepaper][SK-WP]).
Each participant maintains exactly one send chain. Everyone with access to
your chain seed independently derives the same XChaCha20 message keys from
the same chain state. The state is O(N): one chain per sender, not per pair.

Balbás et al. note ([§V-C-3][BALB23]) that vanilla Sender Keys alone is not
sufficient for post-compromise security: PCS only fires on member removal and
re-add, leaving a passive adversary who compromised any member's state free to
eavesdrop indefinitely until that event occurs. The KEM ratchet in COVCOM
closes this gap directly. Join-triggered, manual, and auto-every-25 ratchets
are all PCS boundaries that Sender Keys by itself does not provide.

Distributing the chain seed to N people securely is where the KEM work
happens. When you ratchet, you generate one 32-byte shared seed, then
KEM-encrypt it separately for each peer. Each peer gets a distinct `kemCt`
that only they can decapsulate, but the same seed once they do. They call
`ratchetInit` on that seed (`KDF_SCKA_INIT`, [§5.4][S54]), which derives an
initial root key, send chain key, and receive chain key in a single 96-byte
HKDF expansion. From there, your send chain and their receive chain of you
are synchronized without any further communication.

The room ID bytes travel as a context value through every HKDF call. Two
sessions sharing the same chain seed in different rooms produce completely
independent key material.

Epochs are per-sender and independent. Alice can be at epoch 3 while Bob is
still at epoch 1. Neither triggers the other's ratchet. When a receiver
processes an incoming ratchet step, they prune sender state older than three
epochs back, keeping the current epoch plus two previous. This is one wider
than the Signal spec's `ClearOldEpochs` ([§5.7][S57]), which keeps only the
current and previous; the extra window improves tolerance for messages that
arrive slightly out of epoch order.

---

## joining a room

A room is identified by a 32-byte ID and gated by a 16-byte `roomSecret`
generated by the server at creation time. Both fields are encoded in the
invite: a binary blob serialized as version byte, room ID, room secret, and
an optional DNS field, totalling 49 bytes minimum. The invite is armored
into a PEM-like block for copy-paste sharing or saved as a `.room` file.

When you join, your client creates a fresh `Session` with a new keypair
generated at that moment. You send `identify`, and every existing member
immediately relays their current chain seed to you: a KEM-encrypted blob
addressed to your new public key, carrying their current epoch number and
the 32-byte seed for that epoch. You decrypt each blob, call `ratchetInit`
on the seed, and set up a receive chain for each sender at whatever epoch
they are actually at. If Alice is at epoch 3 and Bob is at epoch 1, you
enter at exactly those positions, not at epoch 0.

Once you have received a seed from every current member, you fire the
welcome ratchet. The joiner always initiates this step, not the existing
members — the joiner is the only principal guaranteed to be present at join
time, so no host election is needed and the protocol stays symmetric. Your
epoch advances, and you broadcast your fresh chain credentials to the group. Existing members set up receive chains for you
and can now decrypt your messages. You are in.

Messages sent while you were joining are not recoverable. You were not
there; those XChaCha20 keys are gone. This is correct forward secrecy
behavior.

---

## session lifecycle

A client moves through four phases during its time in a room: landing,
joining, waiting, and ready.

**Landing.** The entry screen where you create a room or paste an
invite. No WebSocket exists yet.

**Joining.** The brief window between sending a `create` or `join` and
receiving `joined` from the server. The WebSocket is open but the
session has not been initialized; nothing arrives in this state except
the handshake response or an error.

**Waiting.** The lobby. The session is initialized but no peers share
the room with you. This happens in three situations: you just created
the room, you joined a room that exists but has no active members, or
every other participant has left. The lobby displays the invite code
so others can join.

**Ready.** Active chat. At least one peer is in the room with you and
the welcome ratchet has fired.

The novel transition in this lifecycle is `ready → waiting`. When the
last peer leaves, you stay in the room and your chat history stays on
screen. The client disposes the session, wiping every key, and
generates a fresh keypair. It then sends `rekey` to the server,
carrying the new encryption and ratchet public keys. The server
confirms via `rekeyed`, silently updating its connection record. No
`peer_joined` broadcast fires; from any other observer's perspective
nothing happened. When the next peer arrives, the normal handshake
runs against the fresh keypair.

The `rekey` message is permitted only on a connection that has already
identified. Authentication is implicit. The server checks that the
connection has a username on file. An attacker cannot rekey as Alice
without controlling Alice's open TCP connection, and once Alice
disconnects, the connection is closed before any rekey could arrive.

A real disconnect is different. Connection drops, sleep events, and
network switches close the WebSocket entirely. The server's
`handleClose` runs and tears down the connection record. The client
polls `/health_check` until the server responds 200, opens a new
WebSocket, and sends `join` with the saved `roomId` and `roomSecret`.
Identify runs with a fresh keypair. The welcome ratchet fires. Chat
history already rendered remains on screen across the reconnect;
nothing was persisted, so closing the tab still erases everything.
Messages sent while you were offline are unrecoverable, which is
correct forward secrecy behavior. If your username was claimed by
someone else while you were offline, identify returns `username_taken`
and you choose a new name.

Simultaneous joins are sequenced by the server. WebSocket over TCP
guarantees every existing member sees `peer_joined` events in the same
order, and the ratchet path on every client is synchronous, with no
`await` between receiving `peer_joined` and finishing the corresponding
ratchet step. A second join cannot interleave with the first, which
keeps epoch state consistent regardless of how close two joins land in
time.

The room creator is not a privileged principal. After receiving
`room_created`, the creator sends `join` exactly like any other client
and walks the same handshake. From the moment they identify, they
appear in `joined.members` for the next joiner. There is no host, no
session owner, and no special-case wire flow for creators.

---

## the server

The server is a WebSocket message relay built with Bun. It is intentionally
as ignorant as possible.

It knows: room IDs, usernames (first-come-first-served per room), public
encapsulation keys and ratchet public keys per connection, and which
connections are in which rooms. It sees encrypted blobs. It routes them.
That is all it does.

The server does not decrypt anything, store messages, or participate in key
exchange. When it receives a `relay` message addressed to a peer, it
forwards the ciphertext to that peer and nothing else. When it receives a
`broadcast`, it fans the ciphertext out to every other connection in the
room. It cannot read either.

Rooms persist in memory until the TTL cron runs, defaulting to 24 hours of
inactivity. This is not the server keeping a record of conversations; it is
the server staying alive long enough for participants to reconnect after a
dropped connection. When the last connection drops and the idle clock runs
out, the room is deleted.

Room creation is optionally gated by an `adminToken` set via environment
variable. This is a server-side secret that never appears in the invite or
the client bundle. It controls who can create rooms; joining is controlled
entirely by the `roomSecret` embedded in the invite, which the server
validates on every `join` message.

When a client disconnects, the server broadcasts `peer_left` and removes
the connection. The remaining members remove that sender's state. The
client side of the reconnect flow is covered in
[session lifecycle](#session-lifecycle).

---

## the clients

COVCOM ships two clients and a Docker image.

The web client is a Vite-built TypeScript application with no UI framework.
Its state machine is a single module-level variable tracking the session
phase: landing, joining, waiting in the lobby, and chat. System events
such as peer joins, peer departures, and other people's key rotations are
toggleable. Your own key rotations are always visible.

The CLI is a compiled Bun binary with a custom terminal UI built from
scratch using only `process.stdin`, `process.stdout`, and ANSI escape
sequences. No external dependencies. It targets the ANSI 16-color palette
to work correctly across tmux sessions, SSH connections, and common terminal
emulators without palette remapping artifacts. Per-slot color overrides are
available in `~/.config/covcom/config.json`, supporting ANSI16, 256-color
indices, or truecolor hex values.

The lobby screen in the CLI shows a table of the active cipher suite:
cipher, KEM, and format version. This is the only place in the entire
codebase that uses box-drawing characters.

The Docker image is two stages: a Bun build stage for the web client and
server, then Caddy 2 Alpine as a reverse proxy with the Bun server behind
it. There are no build arguments. All configuration is runtime environment
variables.

---

## security properties

**Forward secrecy.** Every message uses a unique XChaCha20 key derived by
stepping the send chain forward. The chain key is overwritten immediately;
the message key is wiped after use. A device compromised after a
conversation cannot reconstruct the keys that protected it.

**Post-compromise security.** PCS recovers at ratchet boundaries. Between
ratchets, a compromised device can decrypt messages from the current epoch
until the next ratchet fires. The auto-ratchet interval bounds this window
to roughly 25 messages per sender under normal conditions. Sender Keys alone
does not provide this property ([Balbás et al., §V-C-3][BALB23]); the KEM
ratchet is what supplies it. The Signal spec notes ([§8.9][S89]) that dropped
messages can slow ratchet progress in sparse PQ ratcheting, because KEM
advancement is causal; this is an accepted tradeoff of the SPQR design.

**Harvest-now, decrypt-later resistance.** Classical DH ratchet healing
cannot protect recorded ciphertexts against a future quantum computer.
ML-KEM-768 is a [FIPS 203][FIPS203] lattice-based KEM standardized for
post-quantum resistance. Ciphertexts captured today remain opaque to a
quantum adversary ([§8.11][S811]).

**Enumeration resistance.** `roomSecret` is 16 server-generated random
bytes, a 2^128 space. You cannot guess a room to join; you need an invite.

**Zero persistent identity.** No accounts, no registration, no retained
history. Usernames are per-room and first-come-first-served. When the room
expires, nothing remains. The server never sees a persistent identity key —
it only knows your public key for the duration of a session. Signal's X3DH
handshake requires long-term identity keys that the server observes during
initial key agreement ([Johansen et al.][JOH18]); COVCOM has no equivalent.
There is nothing to correlate across sessions.

---

## honest limitations

**No header encryption.** Ratchet public keys and epoch numbers in
`ratchet_step` and `ek_update` messages are visible to the server. An
observer can track when participants rotate and at what epoch, even without
reading message content. [§4][S4] of the Double Ratchet spec describes the
header encryption variant that conceals this metadata; it is not implemented
here.

**No previous-chain-length field.** [§5.7][S57] describes a mechanism for
sealing old epoch chains precisely, using a `PN` field in the ratchet header
to let receivers finalize and discard the previous chain as soon as they can.
Without it, old epoch state remains open until the three-epoch pruning window
closes. For ephemeral chat the difference is small, but it is a known
deviation from the tightest possible PCS cleanup.

**No signed session transcripts.** Authentication covers individual
ciphertexts; Poly1305 tells you the message was encrypted by someone who
held the chain key. It does not prove the server delivered messages in the
order they were sent. The server could reorder or replay within a session
without either party being able to prove it cryptographically.

**Username squatting on reconnect.** The session model has no persistent
identity. If you disconnect and someone else claims your username before you
reconnect, you rejoin as a stranger with a new name. This is a known
limitation of the first-come-first-served model and is acceptable for
ephemeral use.

---

[SK-WP]:    https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf
[BALB23]:   https://arxiv.org/pdf/2301.07045
[JOH18]:    https://www.researchgate.net/publication/326550093_The_Snowden_Phone_A_Comparative_Survey_of_Secure_Instant_Messaging_Mobile_Applications_authors_version
[RFC8439]:  https://datatracker.ietf.org/doc/html/rfc8439
[RFC5869]:  https://datatracker.ietf.org/doc/html/rfc5869
[S22]:      https://signal.org/docs/specifications/doubleratchet/#symmetric-key-ratchet
[S26]:      https://signal.org/docs/specifications/doubleratchet/#out-of-order-messages
[S4]:       https://signal.org/docs/specifications/doubleratchet/#double-ratchet-with-header-encryption
[S5]:       https://signal.org/docs/specifications/doubleratchet/#the-sparse-post-quantum-ratchet
[S54]:      https://signal.org/docs/specifications/doubleratchet/#spqr-initialization
[S57]:      https://signal.org/docs/specifications/doubleratchet/#spqr-clearing-past-epoch-state
[S72]:      https://signal.org/docs/specifications/doubleratchet/#recommended-cryptographic-algorithms
[S89]:      https://signal.org/docs/specifications/doubleratchet/#effect-of-dropped-messages-on-pcs
[S811]:     https://signal.org/docs/specifications/doubleratchet/#harvest-now-decrypt-later-attacks
[DR-RENAME]: https://github.com/trevp/double_ratchet/wiki/Home/_compare/6fa4a516b01327d736df1f52014d8b561a18189a...ab41721f9ed7ca0bdac3e24ce9fc573750e0614d
[LC-PR12]:  https://github.com/xero/leviathan-crypto/pull/12
[FIPS203]:  https://csrc.nist.gov/pubs/fips/203/final
