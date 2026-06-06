import { beforeAll, describe, expect, test } from 'bun:test';
import { initCrypto } from '../src/init.js';
import {
	FILE_CHUNK_SIZE, forEachChunk, SealStream, OpenStream, XChaCha20Cipher,
	WINDOW, ACK_INTERVAL, RELAY_TAG_SEED, RELAY_TAG_FILE_ACK,
	prefixTag, readRelayTag, encodeFileAck, decodeFileAck,
} from '../src/index.js';

beforeAll(async () => {
	await initCrypto();
});

describe('forEachChunk', () => {
	// Collect (seq, len, final) for a given size/chunkSize without real bytes.
	async function plan(size: number, chunkSize: number): Promise<{ seq: number; len: number; final: boolean }[]> {
		const out: { seq: number; len: number; final: boolean }[] = [];
		await forEachChunk(
			(_offset, len) => Promise.resolve(new Uint8Array(len)),
			size, chunkSize,
			(chunk, seq, final) => {
				out.push({ seq, len: chunk.length, final });
			},
		);
		return out;
	}

	test('zero-byte source yields exactly one final empty chunk', async () => {
		expect(await plan(0, 16)).toEqual([{ seq: 0, len: 0, final: true }]);
	});

	test('exact multiple splits evenly, last chunk is final', async () => {
		expect(await plan(32, 16)).toEqual([
			{ seq: 0, len: 16, final: false },
			{ seq: 1, len: 16, final: true },
		]);
	});

	test('ragged tail: final chunk is the remainder', async () => {
		expect(await plan(40, 16)).toEqual([
			{ seq: 0, len: 16, final: false },
			{ seq: 1, len: 16, final: false },
			{ seq: 2, len: 8,  final: true },
		]);
	});

	test('single short chunk is final', async () => {
		expect(await plan(5, 16)).toEqual([{ seq: 0, len: 5, final: true }]);
	});

	test('reads exactly the requested slice offsets', async () => {
		const offsets: number[] = [];
		await forEachChunk(
			(offset, len) => {
				offsets.push(offset); return Promise.resolve(new Uint8Array(len));
			},
			40, 16, () => { /* noop */ },
		);
		expect(offsets).toEqual([0, 16, 32]);
	});
});

describe('SealStream/OpenStream chunked round-trip', () => {
	function key(): Uint8Array {
		return crypto.getRandomValues(new Uint8Array(XChaCha20Cipher.keySize));
	}

	// Mirror exactly what the clients do: seal each plaintext slice into a frame,
	// then open the preamble + frames back in order.
	async function roundTrip(plaintext: Uint8Array, chunkSize: number): Promise<Uint8Array> {
		const k      = key();
		const sealer = new SealStream(XChaCha20Cipher, k, { chunkSize });
		const frames: Uint8Array[] = [];
		await forEachChunk(
			(offset, len) => Promise.resolve(plaintext.subarray(offset, offset + len)),
			plaintext.length, chunkSize,
			(chunk, _seq, final) => {
				frames.push(final ? sealer.finalize(chunk) : sealer.push(chunk));
			},
		);
		const opener = new OpenStream(XChaCha20Cipher, k.slice(), sealer.preamble);
		const out: Uint8Array[] = [];
		for (let i = 0; i < frames.length; i++)
			out.push(i === frames.length - 1 ? opener.finalize(frames[i]) : opener.pull(frames[i]));
		const total = out.reduce((n, c) => n + c.length, 0);
		const joined = new Uint8Array(total);
		let pos = 0;
		for (const c of out) {
			joined.set(c, pos); pos += c.length;
		}
		return joined;
	}

	test('multi-chunk payload decrypts identically', async () => {
		const pt = crypto.getRandomValues(new Uint8Array(40_000));
		const rt = await roundTrip(pt, 16_384);
		expect(rt).toEqual(pt);
	});

	// Exercises the real constant end to end: a too-large FILE_CHUNK_SIZE would
	// make SealStream.push throw ("plaintext exceeds 65536 bytes"), so this guards
	// against the chunk size drifting past the XChaCha20 WASM limit.
	test('round-trips at the real FILE_CHUNK_SIZE across several chunks', async () => {
		const pt = crypto.getRandomValues(new Uint8Array(FILE_CHUNK_SIZE * 2 + 1234));
		const rt = await roundTrip(pt, FILE_CHUNK_SIZE);
		expect(rt).toEqual(pt);
	});

	test('empty payload round-trips', async () => {
		const rt = await roundTrip(new Uint8Array(0), 16_384);
		expect(rt.length).toBe(0);
	});

	test('a tampered chunk fails to open (AEAD integrity)', async () => {
		const k      = key();
		const sealer = new SealStream(XChaCha20Cipher, k, { chunkSize: 16_384 });
		const c0     = sealer.push(crypto.getRandomValues(new Uint8Array(16_384)));
		sealer.finalize(crypto.getRandomValues(new Uint8Array(10)));
		c0[5] ^= 0xff;   // flip a byte in the first chunk's ciphertext
		const opener = new OpenStream(XChaCha20Cipher, k.slice(), sealer.preamble);
		expect(() => opener.pull(c0)).toThrow();
	});

	test('FILE_CHUNK_SIZE is within leviathan stream bounds', () => {
		expect(FILE_CHUNK_SIZE).toBeGreaterThanOrEqual(1024);
		expect(FILE_CHUNK_SIZE).toBeLessThanOrEqual(16_777_215);
	});
});

describe('relay tag framing + file ack codec', () => {
	test('tag constants are the wire-locked values', () => {
		expect(RELAY_TAG_SEED).toBe(0x00);
		expect(RELAY_TAG_FILE_ACK).toBe(0x01);
	});

	test('pacing window acks at least twice per window', () => {
		expect(ACK_INTERVAL).toBeLessThan(WINDOW);
		expect(WINDOW % ACK_INTERVAL).toBe(0);
	});

	test('prefixTag/readRelayTag round-trip preserves the body', () => {
		const body = crypto.getRandomValues(new Uint8Array(64));
		const { tag, body: out } = readRelayTag(prefixTag(RELAY_TAG_SEED, body));
		expect(tag).toBe(RELAY_TAG_SEED);
		expect(out).toEqual(body);
	});

	test('readRelayTag splits the tag from an arbitrary first byte', () => {
		const p = readRelayTag(Uint8Array.from([0x01, 9, 8, 7]));
		expect(p.tag).toBe(0x01);
		expect(p.body).toEqual(Uint8Array.from([9, 8, 7]));
	});

	test('encode/decode file ack round-trips a real uuid + large seq', () => {
		const fileId = crypto.randomUUID();
		const seq    = 16_383;
		const wire   = encodeFileAck(fileId, seq);
		expect(wire[0]).toBe(RELAY_TAG_FILE_ACK);
		const { tag, body } = readRelayTag(wire);
		expect(tag).toBe(RELAY_TAG_FILE_ACK);
		expect(decodeFileAck(body)).toEqual({ fileId, seq });
	});

	test('ack body is unambiguously tagged, never mistaken for a seed', () => {
		const { tag } = readRelayTag(encodeFileAck('abc', 0));
		expect(tag).not.toBe(RELAY_TAG_SEED);
	});

	test('decodeFileAck never throws on hostile input, returns an ignored sentinel', () => {
		const sentinel = { fileId: '', seq: -1 };
		expect(decodeFileAck(new TextEncoder().encode('not json'))).toEqual(sentinel);
		expect(decodeFileAck(new Uint8Array([0xff, 0xfe]))).toEqual(sentinel);
		expect(decodeFileAck(new TextEncoder().encode('{}'))).toEqual(sentinel);
		expect(decodeFileAck(new TextEncoder().encode('{"f":123,"s":"x"}'))).toEqual(sentinel);
		expect(decodeFileAck(new TextEncoder().encode('null'))).toEqual(sentinel);
	});
});
