// covcom protocol manifest: the single source of truth for the wire-contract
// version and the protocol-identifying display facts (the crypto table the
// clients show). Clients and the server read these instead of copying literals,
// so the values cannot drift between artifacts the way the CLI lobby's stale
// 0x01 drifted from the web client's 0x03.

// covcom's own wire contract, hand-bumped. Deliberately an integer, not derived
// from a crypto enum: the wire contract can break for reasons unrelated to the
// cipher (a new handshake field, a changed message schema), and leviathan can
// bump a format enum without breaking covcom. Coupling them would make the
// version lie in both directions.
export const PROTOCOL_VERSION = 3;

// '0x' + zero-padded byte. Computed once here so the version byte is never
// re-stringified independently by a client.
function hex(n: number): string {
	return '0x' + n.toString(16).padStart(2, '0');
}

// Curated protocol facts, defined once so the cli and web crypto tables can't
// drift. protocolVersionHex is the client's own wire version, rendered in the
// table so a user has something to read off when they hit a version mismatch.
export const PROTOCOL = {
	cipherName: 'XChaCha20-Poly1305',
	kemName: 'ML-KEM-768',
	protocolVersionHex: hex(PROTOCOL_VERSION),
	autoRatchetEvery: 25,
};

// component -> primitive, in display order. The cli ascii table and the web
// definition list both map over this so they render identical facts. Names that
// derive from the manifest do; the architecture rows are curated strings with no
// API handle to read them from.
export const CRYPTO_TABLE: readonly (readonly [string, string])[] = [
	['AEAD cipher', PROTOCOL.cipherName],
	['key derivation', 'HKDF-SHA-256'],
	['key encapsulation', PROTOCOL.kemName],
	['signatures', 'Ed25519'],
	['fingerprint', 'BLAKE3'],
	['transparency chain', 'SHA-256 Merkle'],
	['group model', 'sender keys, O(N)'],
	['forward secrecy + PCS', 'sparse PQ ratchet'],
	['protocol format', PROTOCOL.protocolVersionHex],
];
