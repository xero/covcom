// covcom protocol manifest: the single source of truth for the wire-contract
// version and the protocol-identifying display facts (cipher / KEM names, the
// crypto format bytes). Clients and the server read these instead of copying
// literals, so the values cannot drift between artifacts the way the CLI
// lobby's stale 0x01 drifted from the web client's 0x03.

import { XChaCha20Cipher, Ed25519PreHashSuite } from 'leviathan-crypto';

// covcom's own wire contract, hand-bumped. Deliberately an integer, not derived
// from a crypto enum: the wire contract can break for reasons unrelated to the
// cipher (a new handshake field, a changed message schema), and leviathan can
// bump a format enum without breaking covcom. Coupling them would make the
// version lie in both directions.
export const PROTOCOL_VERSION = 3;

// '0x' + zero-padded byte. Computed once here so a format byte is never
// re-stringified independently by a client.
function hex(n: number): string {
	return '0x' + n.toString(16).padStart(2, '0');
}

// Curated names live here once (the suite objects only carry the lowercase
// formatName, e.g. 'xchacha20'); the format/sig bytes are derived from the
// suite objects so no literal can drift.
export const PROTOCOL = {
	cipherName: 'XChaCha20-Poly1305',
	kemName: 'ML-KEM-768',
	cipherFormat: XChaCha20Cipher.formatEnum,
	cipherFormatHex: hex(XChaCha20Cipher.formatEnum),
	sigFormat: Ed25519PreHashSuite.formatEnum,
	autoRatchetEvery: 25,
};
