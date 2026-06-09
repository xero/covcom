import { describe, expect, test } from 'bun:test';
import { CRYPTO_TABLE, PROTOCOL, PROTOCOL_VERSION } from '../src/protocol.js';

// The crypto table is the single source both clients render, so these assertions
// stand in for "the cli ascii box and the web dl show the same, correct facts".
describe('CRYPTO_TABLE', () => {
	test('lists every component in display order', () => {
		expect(CRYPTO_TABLE.map(([component]) => component)).toEqual([
			'AEAD cipher',
			'key derivation',
			'key encapsulation',
			'signatures',
			'fingerprint',
			'transparency chain',
			'group model',
			'forward secrecy + PCS',
			'protocol format',
		]);
	});

	test('cipher and KEM rows track the PROTOCOL manifest', () => {
		const byComponent = new Map(CRYPTO_TABLE);
		expect(byComponent.get('AEAD cipher')).toBe(PROTOCOL.cipherName);
		expect(byComponent.get('key encapsulation')).toBe(PROTOCOL.kemName);
	});

	// The format row is a diagnostic: it must equal the client's own wire version
	// so a user hitting a version mismatch can read off what they are running. If
	// PROTOCOL_VERSION bumps and this row drifts, that diagnostic lies.
	test('protocol format row is the wire version, zero-padded hex', () => {
		const byComponent = new Map(CRYPTO_TABLE);
		expect(byComponent.get('protocol format')).toBe(PROTOCOL.protocolVersionHex);
		expect(PROTOCOL.protocolVersionHex).toBe(
			'0x' + PROTOCOL_VERSION.toString(16).padStart(2, '0'),
		);
	});
});
