import { beforeAll, describe, expect, test } from 'bun:test';
import { initCrypto } from '../src/init.js';
import { generateKeypair } from '../src/keypair.js';

// ML-KEM-768 (FIPS 203) key sizes.
const EK_BYTES = 1184;
const DK_BYTES = 2400;

beforeAll(async () => {
	await initCrypto();
});

describe('generateKeypair', () => {
	test('returns ML-KEM-768 encapsulation/decapsulation keys of the right size', () => {
		const { ek, dk } = generateKeypair();
		expect(ek).toBeInstanceOf(Uint8Array);
		expect(dk).toBeInstanceOf(Uint8Array);
		expect(ek.length).toBe(EK_BYTES);
		expect(dk.length).toBe(DK_BYTES);
	});

	test('each call produces fresh, distinct key material', () => {
		const a = generateKeypair();
		const b = generateKeypair();
		expect(Buffer.from(a.ek).equals(Buffer.from(b.ek))).toBe(false);
		expect(Buffer.from(a.dk).equals(Buffer.from(b.dk))).toBe(false);
	});

	test('keys are not all-zero', () => {
		const { ek, dk } = generateKeypair();
		expect(ek.some(byte => byte !== 0)).toBe(true);
		expect(dk.some(byte => byte !== 0)).toBe(true);
	});
});
