# Changelog

## v3.0.1

This release adds rich-text formatting to messages on both clients and hardens
every path that renders peer-controlled text. Untrusted display data is now
treated as data, never as code. It also reworks file transfer to stream in
bounded chunks with receiver-paced flow control, so large attachments move
reliably without crashing the renderer. Clients and the server now negotiate a
protocol version when you create or join a room, so a version skew is rejected
cleanly at the door instead of failing as cryptic dropped messages.

> [!WARNING]
> **Breaking wire-protocol change**. File transfer drops the single `file`
> envelope for a `file-begin` frame followed by `file-chunk` frames, and every
> peer-to-peer relay payload now carries a one-byte tag prefix. Both clients
> must run v3.0.1. A v3.0.0 client cannot receive files from a v3.0.1 peer, and
> the tagged relay payload breaks its key handshake outright, so mixed-version
> rooms fail to connect rather than just failing to share files. Version
> negotiation now catches this case at join time and returns the client to the
> start screen with a clear message instead of a cryptic handshake failure.

### Security

**No HTML-string path in the web client.** A `SafeHtml` branded type and a
single `setHtml()` sink replace every ad-hoc `innerHTML` write. The only values
minted as trusted HTML are the bundled SVG icons; all other DOM is built through
`createElement` and `textContent`. A peer-controlled value can no longer become
markup, which closes the XSS and mXSS surface.

**ReDoS-immune markup parser.** The shared markup model is a hand-written linear
scanner, not a backtracking regex. It is DOM-free and crypto-free and emits a
token tree, so no renderer ever assembles an HTML string from untrusted input.

**Bidi and zero-width spoofing defense.** Untrusted display text is stripped of
bidirectional controls and zero-width format characters on both clients before
rendering, and the web client isolates message and name spans with CSS
`unicode-bidi: isolate`. This defeats Trojan-Source text reordering and
zero-width or homoglyph display-name spoofing. ZWNJ, ZWJ, and variation
selectors stay allowed because they are legitimate in emoji and in Persian,
Arabic, and Indic text.

**Terminal escape-injection defense in the CLI.** Peer usernames, message
bodies, filenames, event-log keys and values, and fingerprint names now pass
through a terminal sanitizer that strips ANSI, CSI, and OSC sequences (including
OSC 52 clipboard writes), stray control bytes, and HTML-ish tags before the CLI
emits its own SGR. A hostile peer can no longer move the cursor, clear the
screen, or write the clipboard through chat content.

**Server username hardening.** On `identify` the relay rejects (closes) any
username containing C0/C1 control characters, DEL, or the bidi and zero-width
format characters used for display-name spoofing. The server rejects rather
than sanitizes, because the username is bound by the signed identity claim and
silently altering it would break peer verification.

**Clickjacking protection on the container.** Caddy now sends
`X-Frame-Options: DENY`. The equivalent `frame-ancestors` directive moved out of
the web client's `<meta>` CSP, where browsers silently ignore it, into a real
response header.

### Added

**Rich text in messages.** Both clients render a markdown subset in message
bodies: bold (`*`), italic (`_`), bold and italic (`_*` or `*_`), inline code
(`` ` ``), and fenced ` ``` ` code blocks. Formatting is display-only; the wire
still carries your exact plaintext.

**CLI code styling.** New `codeFg` and `codeBg` theme slots color inline code
and fenced blocks, fenced blocks render with a filled background, and italic
text now emits the italic SGR.

**Distinct per-sender colors in the CLI.** Each peer's name renders in its own
color in the chat scroll and the verify panel, cycling through seven shared
slots (`peer1` through `peer7`) by join order to match the web client. Your own
name always uses `peer0`, a slot reserved for self. Peers never draw from it,
and they never draw the system-message color, so no peer can paint their name to
look like you or like a server notice.

**Modal keys-display on both clients.** Pressing `Esc` while the message input
is focused swaps the input bar for a row of action units: `R` ratchet, `E`
events, `V` verify, and `Esc` return to chat. Pressing the key fires the action
(shift-insensitive) and closes the display: ratchet returns to the input, events
and verify defer to the panel toggle's own focus move, and `Esc` just returns to
typing. This unifies the keyboard model across clients: it replaces the CLI's
old `Ctrl+R/E/V` chords (now removed) and gives the web a discoverable hotkey
path it never had, since the browser owns those chords. The slash commands
(`/ratchet`, `/events`, `/verify`) still do the same. The CLI units take
optional leading glyphs from three new icon settings, `icons.events`,
`icons.verify`, and `icons.escape`; an unset icon renders nothing.

**More themeable CLI slots.** The send, attach, and ratchet bar buttons take
their own colors (`barBtnBg`, `barBtnFg`, `barBtnFocusBg`, `barBtnFocusFg`),
defaulting to the generic button colors. The attach-mode icon that prefaces the
input box takes `barAttach`. The in-chat "keys rotated" ratchet notice splits
into `keyFg` for the key glyph and `ratchetTxtFg` for the label. System notices
and `/help` output get their own `system` slot, split out from `disabled` so the
two roles recolor independently.

**Receiver flow control for file transfer.** The receiver acknowledges consumed
chunks over the peer-to-peer relay channel and the sender holds a bounded window
of chunks ahead of the slowest recipient, so a large transfer survives a slow or
backpressured relay. The scheme is N-party and paces to the slowest peer.

**Protocol manifest.** A single `lib/src/protocol.ts` now holds covcom's
protocol-identifying values: the cipher and KEM display names, the cipher and
signature format bytes, the auto-ratchet interval, and the wire-contract
version. Web, cli, and server read from it instead of each carrying its own
copy. The cipher-suite tables, ratchet timing, and version checks now share one
source, so they stay consistent across both clients and the server. The format
bytes are derived from the cipher suites, so they track the cipher in use on
their own.

**Protocol version negotiation.** The client sends its protocol version when you
create or join a room, and the server stamps its own version on the reply. A
mismatch returns you to the start screen with a generic "different version"
message instead of hanging or dying with a cryptic decryption error deeper in
the handshake. The check runs in both directions, so it catches an old client
against a new server and a new client against an old server. The version rides
in plaintext as a compatibility gate, not a security boundary; the signed
identity claims still protect against a hostile server.

**Server address autofill.** The web client prefills the connection field with
the host that served the page, which is the relay in the single-container
deployment. Edit it to point at a decoupled relay.

**CLI paranoia flags.** `--clean` ignores the config file entirely, so the
session never reads or writes `~/.config/covcom/config.json`. `--anon` skips
only the saved server and username, leaving them untouched on disk while every
other setting persists as normal.

### Changed

**Unified sender-color names across both clients.** The web's `--sender-0`
through `--sender-7` CSS variables are now `--peer0` through `--peer7`, and the
silver system color is `--system`. The CLI drops the `yourName` theme slot in
favor of `peer0` and renames `peerName0`-`peerName7` to `peer0`-`peer7`. Both
clients now reserve slot 0 for self and cycle peers through slots 1 to 7, so a
peer can no longer wrap onto your color or the system color. A config that still
sets `yourName` or `peerName*` falls back to the defaults for those slots;
update `~/.config/covcom/config.json` to keep a custom palette.

**Confirm-quit on Ctrl+C in the CLI.** A first Ctrl+C now pops a "quit covcom?"
prompt; a second exits and any other key cancels. The `/exit` family still quits
immediately.

**Web message rendering.** User messages render through the shared token model:
fenced blocks become a `<pre>`, and paragraphs preserve their original line
breaks.

**Display-column-aware wrapping in the CLI.** Word wrap now measures display
columns through a pragmatic wcwidth instead of counting code points, so wide
CJK glyphs and emoji wrap and pad at their true width. A word wider than the
pane is hard-split on code-point boundaries and never severs a surrogate pair.

**Docker self-hosting ergonomics.** `docker/run` loads `docker/.env`, fails fast
with a clear message when `DOMAIN` is unset instead of launching a container
that exits on startup, and always builds with `--no-cache` so a rebuild never
serves a stale web client. The image also points Caddy's storage at the mounted
`/data` and `/config` volumes, so the TLS certificate and ACME account survive a
restart.

### Fixed

**Large encrypted file transfer no longer crashes the renderer.** Files stream
as bounded per-chunk frames instead of one monolithic sealed frame, so a big
attachment no longer balloons renderer memory or exceeds the relay's
message-size cap. Multi-hundred-megabyte files now transfer end to end.

**Secure WebSocket scheme on HTTPS deployments.** The web client derives the
socket scheme from the page it loaded, so an HTTPS page connects over `wss://`
instead of attempting a `ws://` connection that the CSP and mixed-content rules
block.

**Clean terminal restore on every CLI exit.** All quit paths (Ctrl+C, the
`/exit` family, `SIGTERM`, a fatal error) now funnel through one `doCleanup`
routine that wipes crypto state and then restores the terminal. The CLI no
longer leaves a stuck alternate-buffer frame, a hidden cursor, or raw mode
behind, and an intentional socket close on the way out no longer prints a
spurious "Connection lost. Reconnecting" notice.

**Web chat input focused on start.** Reaching the chat now focuses the message
box automatically (on first entry and when returning from the lobby), so you can
type straight away without clicking into it first.

**CLI config no longer clobbered on room create.** Creating a room remembered
the server and username with a bare write that overwrote the whole config file,
wiping any saved theme, icons, sidebar width, and `showSystem` on disk. It now
read-merges, so only `server` and `username` are updated and the rest of the
config survives.

---

## v3.0.0

The signing release. Every participant now carries a per-session Ed25519
identity, every message carries a verifiable signature, and each client builds
a tamper-evident log of who said what. **Breaking:** the wire protocol mandates
signed identity claims and per-message signatures, so v3 clients and servers do
not interoperate with earlier versions.

### Added

**Per-session signing identity.** `SessionIdentity` mints a fresh Ed25519
signing key on every join and issues identity claims that bind a peer's session
public key, sender key, username, epoch, and sequence to the session. Claims
chain by BLAKE3 over the previous log root, so the identity log is
tamper-evident.

**Session fingerprint.** Each session derives a `FingerprintSurface` from its
signing key: eight color swatches, a 16-character hex string, and a single
badge color. Peers compare it out of band to confirm they share one consistent
view of the session.

**Safe rich-text model for system messages.** System messages and event-log
summaries render from a token model rather than string concatenation, building
DOM through `textContent` and `createElement` with no HTML-string path. This is
the foundation the unreleased message-formatting work builds on.

### Security

**Per-message provenance.** Every broadcast carries a detached Ed25519ph
signature over `counter || epoch || sender || ts || ciphertext`, verified
before any AEAD work runs. A forged ciphertext fails the signature check first,
and an attacker cannot reattribute a legitimate ciphertext to a different
sender without breaking the signature.

**Metadata integrity.** Every `identify`, `ratchet_step`, and `ek_update`
carries a signed identity claim. Because each claim references the prior
payload's BLAKE3 hash, a server that swaps a peer's ratchet key or signing key
mid-session fails the chain-continuity check. First-contact substitution
remains out of scope and is documented as such.

**Split-view detection.** The per-sender identity log lets two participants who
compare fingerprints out of band detect a server that has fed them divergent
orderings or participant sets.

### User interface

**Fingerprint-verify view.** Both clients gain a verification panel that shows
the session fingerprint swatches and hex for out-of-band comparison.

**Event-log sidebar.** Both clients gain a togglable event log that summarizes
wire activity (joins, ratchet steps, claims, errors) with expandable
per-entry detail. User-controlled fields render as tokens, never as raw markup.

---

## v2.0.0

An internal testing build that was never released to the public. v3 superseded
it before any public release, so there are no user-facing changes to record
here.

---

## v1.0.0

The first public release. End-to-end encrypted group chat with post-quantum
cryptography, ephemeral sessions, and two first-class clients. Share an invite,
talk, close the tab, and the session is gone.

### Added

**Post-quantum encrypted group chat.** Messages and files are sealed with
XChaCha20-Poly1305 under per-message keys. Epoch transitions use ML-KEM-768
(FIPS 203), so recorded ciphertext stays unreadable to a future quantum
adversary.

**Sparse Post-Quantum Ratchet.** Key schedule follows the SPQR design from
Signal's Double Ratchet spec, with HKDF-SHA-256 send chains that wipe each key
after use. Forward secrecy protects past messages, and a KEM ratchet step
restores security after compromise. Steps fire on join, on manual rotation, and
automatically as the session advances.

**N-party rooms.** A Sender Keys group model gives each participant one send
chain rather than one per pair, so session state stays O(N) in room size.

**Ephemeral sessions.** Each participant generates a fresh keypair on every
join, with no account and no persistent identity. Key material lives only in
the client process and is wiped on disconnect.

**Invite-based onboarding.** Creating a room produces an armored invite block
and a `.room` file. A 16-byte server-generated `roomSecret` embedded in the
invite gates joins, so an uninvited party cannot enter even without an admin
token.

**Encrypted file transfer.** Files are encrypted client-side and relayed as
opaque blobs, then saved to the working directory on receipt.

**Self-hostable relay.** The Bun WebSocket server runs behind Caddy with
automatic ACME TLS in Docker, or directly behind your own proxy. It sees only
ciphertext and routes it. Room TTL, maximum room size, and an optional
room-creation admin token are all environment-configurable.

### Clients

**Web client.** A Vite and vanilla-TypeScript browser app. Build it static for
any file host or as a single self-contained HTML file for the Docker image.
Invites paste in or drag and drop as a `.room` file.

**CLI client.** A compiled Bun binary with a custom zero-dependency terminal
UI. Standalone builds ship for macOS (Apple Silicon and Intel), Linux x86_64,
and Windows x86_64. The interface is fully keyboard and mouse driven and
themeable through `ansi16`, 256-color, or truecolor hex slots, with settings
persisted to a config file.
