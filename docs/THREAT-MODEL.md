```
  ▄██▀ ▀█  ▄██▀ █▄  ▀██  ██▀  ▄██▀ ▀█  ▄██▀ █▄   █▄   ▄█
 ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒  ▒▒  ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒▒▄▒▒▒
 ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒▌ ▒▒  ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒ ▀ ▒▒
  ▀██▄ ▄█  ▀██▄ █▀    ▀█▄▀    ▀██▄ ▄█  ▀██▄ █▀  ▄██▄ ▄██▄

XChaCha20 · ML-KEM-768 · SPQR · E2EE · ephemeral · N-party
```

# COVCOM Threat Model

> [!NOTE]
> A formal adversarial analysis of COVCOM using the Dolev-Yao model.
> Defines principals, adversary capabilities, protocol guarantees, and
> explicit non-goals.

> ### Table of Contents
> - [principals](#principals)
> - [cryptographic assumptions](#cryptographic-assumptions)
> - [the server trust model](#the-server-trust-model)
> - [adversary tiers](#adversary-tiers)
> - [protocol guarantees](#protocol-guarantees)
> - [non-goals](#non-goals)

---

## principals

The protocol involves four classes of principal:

**Participants** (Alice, Bob, Charlie, …) are the N clients in a session.
Each participant generates a fresh keypair on every join. They have no
persistent identity outside a session. Their private key material lives
only in the client process and is wiped on disconnect.

**S** is the relay server. S is a potentially dishonest principal with
constrained capabilities. S routes messages, tracks room membership, and
holds session public keys. S sees only ciphertext. The protocol is designed
so that S's dishonesty cannot violate confidentiality — only availability
and metadata.

**D** is the delivery network between clients and S: the transport layer,
ISPs, and any infrastructure carrying packets. D is fully controlled by the
adversary.

**A** is the adversary. A's capabilities are defined by tier in the section
below.

---

## cryptographic assumptions

The protocol's security rests on the following hardness assumptions. A is
assumed computationally bounded and unable to break any of them.

**ML-KEM-768 IND-CCA2** ([FIPS203][FIPS203]). A cannot recover the
encapsulated shared secret from a KEM ciphertext without the decapsulation
key. This holds against classical and quantum adversaries.

**HKDF-SHA-256 PRF security** ([RFC5869][RFC5869]). The key derivation
function behaves as a pseudorandom function. A cannot distinguish its output
from random without knowledge of the input key material.

**XChaCha20-Poly1305 AEAD security** ([RFC8439][RFC8439]). A cannot decrypt
a ciphertext or forge a valid authentication tag without the key. The
192-bit nonce space makes accidental nonce reuse negligible regardless of
message volume.

**Seal+KyberSuite IND-CCA2.** The KEM-based public-key encryption scheme
used for chain seed distribution is IND-CCA2 secure under the ML-KEM-768
assumption.

---

## the server trust model

S occupies an unusual position: it is a required participant in message
delivery but is explicitly not trusted with message content. The model
makes this precise.

**S is assumed to provide liveness.** S will eventually deliver messages to
their intended recipients. Without this assumption there is no protocol to
analyze — a server that drops all messages trivially prevents communication
but learns nothing cryptographically interesting. Availability attacks are
outside the scope of this threat model.

**S is honest-but-curious at minimum.** S follows the protocol correctly but
may log and analyze everything it observes. What S observes is bounded:
room IDs, usernames, session public keys, ciphertext blobs, and connection
timing. S never observes plaintext, chain keys, or KEM private keys.

**S may be actively malicious with respect to metadata.** S could lie about
room membership in the `joined` message, presenting a fake member list or
omitting members. S could reorder or selectively delay messages within a
session. These attacks affect the session's consistency properties but not
the confidentiality of individual messages. A dishonest S cannot forge a
message that passes Poly1305 verification, cannot recover a chain key from
observed ciphertext, and cannot decrypt a KEM-sealed chain seed addressed
to a participant whose private key S does not hold.

**S holds session public keys.** On `identify`, each participant sends their
encapsulation key `ek` and ratchet key `ratchetEk`. S stores these for the
duration of the session and uses them to route ratchet step payloads. This
means S observes when ratchet keys rotate and at what epoch. Header
encryption is not implemented; this is a known limitation documented in
[PROTOCOL.md](./PROTOCOL.md).

---

## adversary tiers

Three adversary tiers cover the range of realistic attack scenarios.

### A₀ — passive network adversary

A₀ observes all traffic between clients and S. A₀ cannot modify messages
in transit.

A₀ learns: ciphertext blobs, message sizes, timing, frequency, session
duration, and the IP addresses of participants. A₀ does not learn message
content, chain keys, or the plaintext of chain seed relay blobs.

The harvest-now-decrypt-later variant of A₀ records ciphertext today and
attempts decryption after acquiring a cryptographically relevant quantum
computer. ML-KEM-768 is standardized for post-quantum resistance and
defeats this attack ([§8.11][S811]).

### A₁ — active network adversary

A₁ has full Dolev-Yao control of the network. A₁ can intercept, inject,
replay, reorder, and drop any message. A₁ controls D entirely and may
also corrupt S.

Against A₁, the protocol provides:

- **Confidentiality.** Injected or replayed ciphertexts fail Poly1305
  authentication and are discarded. A₁ cannot construct a valid ciphertext
  without the current chain key.
- **Replay resistance.** Each message envelope carries an epoch and counter.
  A replayed message from a previous epoch fails key resolution; a replayed
  message within the current epoch fails the counter check.
- **Reorder tolerance.** Out-of-order messages within an epoch are handled
  by `SkippedKeyStore` up to `MAX_SKIP`. Messages reordered across epoch
  boundaries fail key resolution and are discarded.
- **Surgical key-consumption DoS resistance.** `SkippedKeyStore.resolve`
  returns a `ResolveHandle`; the receiver settles via `commit()` only after
  the ciphertext authenticates, and via `rollback()` if Poly1305 rejects.
  A₁ injecting a forged ciphertext at a counter for which a key is cached
  no longer consumes that key — the rollback returns it to the store, so
  the legitimate message at the same counter still decrypts when it
  arrives. A₁ retains the generic ability to drop packets, but cannot
  leverage forgery-then-consumption to deny delivery of specific
  authenticated messages.

A₁ can mount a denial-of-service by dropping messages or disrupting the
join handshake. This is an availability attack, not a confidentiality or
integrity failure.

### A₂ — state compromise adversary

A₂ has A₁ capabilities plus the ability to expose the internal state of one
or more participants at a point in time. State exposure means A₂ obtains
all key material present in the session object at the moment of compromise:
the current chain key, epoch seeds, and skipped key store. A₂ does not
obtain keys that have already been wiped.

Two sub-cases:

**A₂ᶠ — forward compromise.** A₂ obtains a participant's state at time T.
Forward secrecy guarantees that A₂ cannot recover keys for any message sent
before T. The `KDFChain` wipes each chain key before storing the next. Each
message key is wiped immediately after use. Nothing in the current state
allows reconstruction of past keys.

**A₂ᵖ — persistent compromise.** A₂ maintains continuous access to a
participant's state across multiple epochs. Post-compromise security
guarantees that at each KEM ratchet step, fresh randomness from
`kemRatchetEncap` is mixed into the root key via `KDF_SCKA_RK`. A₂ cannot
predict or reproduce this randomness without breaking ML-KEM-768. After a
ratchet step completes, A₂ loses the ability to decrypt subsequent messages
even if they retained the pre-ratchet state.

Vanilla Sender Keys provides no PCS — compromise persists until a member
is removed and re-added ([Balbás et al., §V-C-3][BALB23]). The KEM ratchet
closes this gap. Three events guarantee a PCS boundary: join, manual
rotate, and auto-ratchet every 25 messages.

The window of exposure under A₂ᵖ is bounded to roughly 25 messages per
sender at normal chat pace. The Signal spec notes ([§8.9][S89]) that dropped
messages containing `kemCt` stall ratchet advancement, because the
decapsulator cannot advance without the ciphertext. This is the fundamental
asymmetry of KEM-based ratcheting versus classic DH, and it is an accepted
tradeoff of the SPQR design ([§5][S5]).

---

## protocol guarantees

Against the adversaries defined above, COVCOM provides the following
guarantees.

**Message confidentiality.** No adversary tier recovers plaintext from
observed ciphertext without the current chain key. Holds against A₀, A₁,
and A₂ᶠ. Under A₂ᵖ, confidentiality holds for all messages outside the
current compromise window.

**Message authentication.** Poly1305 ensures that every accepted message
was encrypted by a principal holding the current chain key for that sender.
A₁ cannot forge a valid ciphertext. This is symmetric authentication — it
does not provide cryptographic deniability (see non-goals).

**Forward secrecy.** A₂ᶠ cannot recover keys for messages sent before the
compromise. Chain keys and message keys are wiped immediately after use.

**Post-compromise security.** A₂ᵖ loses access to future messages after the
next KEM ratchet step introduces fresh randomness. PCS boundaries occur at
join, manual rotate, and auto-ratchet (every 25 messages).

**Harvest-now-decrypt-later resistance.** ML-KEM-768 is a FIPS 203
lattice-based KEM. Recorded ciphertexts remain opaque to a future quantum
adversary ([§8.11][S811]).

**Enumeration resistance.** The `roomSecret` is 16 server-generated random
bytes. The 2^128 space makes brute-force room discovery computationally
infeasible for A₁.

**Session anonymity.** The server holds no persistent identity material.
Each session uses a fresh keypair. There is no long-term identity key that
S observes across sessions, unlike Signal's X3DH handshake which requires
long-term identity keys visible to the server during initial key agreement
([Johansen et al.][JOH18]). A₀ and S can observe that an IP address
connected to the server but cannot link sessions to a persistent identity.

---

## non-goals

The following are explicitly outside the scope of this threat model.

**Endpoint security.** If A compromises the client device — through malware,
physical access, or operating system exploitation — all session key material
is accessible. The protocol cannot protect against an adversary with
direct access to the process memory or filesystem of a participant.

**Traffic analysis.** A₀ observes message timing, frequency, and volume.
COVCOM does not implement traffic shaping, padding, or cover traffic. An
observer can infer that a session is active, how many messages were
exchanged, and their approximate sizes.

**Cryptographic deniability.** Poly1305 authentication uses a symmetric key.
A participant who holds the chain key can prove to a third party that a
given ciphertext was produced by someone holding that key. This is weaker
than the deniability provided by Signal's use of X3DH, where the key
material is structured to allow transcript forgery.

**Global transcript consistency.** The server could selectively deliver
messages to different participants, causing divergent views of the
conversation. COVCOM does not implement consistency checks across
participants.

**Multi-session correlation by endpoints.** A participant who rejoins a room
with a new session will use a different keypair and username. The protocol
does not prevent the same human from being correlated across sessions by
out-of-band means (same username choice, writing style, timing patterns).

**Server availability.** A server that drops messages or refuses connections
prevents communication. Denial-of-service against S is not a
cryptographic attack and is outside this model.

---

[FIPS203]:  https://csrc.nist.gov/pubs/fips/203/final
[RFC5869]:  https://datatracker.ietf.org/doc/html/rfc5869
[RFC8439]:  https://datatracker.ietf.org/doc/html/rfc8439
[BALB23]:   https://arxiv.org/pdf/2301.07045
[JOH18]:    https://www.researchgate.net/publication/326550093_The_Snowden_Phone_A_Comparative_Survey_of_Secure_Instant_Messaging_Mobile_Applications_authors_version
[S5]:       https://signal.org/docs/specifications/doubleratchet/#the-sparse-post-quantum-ratchet
[S89]:      https://signal.org/docs/specifications/doubleratchet/#effect-of-dropped-messages-on-pcs
[S811]:     https://signal.org/docs/specifications/doubleratchet/#harvest-now-decrypt-later-attacks
