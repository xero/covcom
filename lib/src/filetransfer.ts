// Streamed file transfer over the chat wire.
//
// A file is sent as a sequence of `broadcast` frames (no new server message
// type): one `file-begin` carrying the SealStream preamble + metadata, then N
// `file-chunk` frames each holding one encrypted chunk. leviathan's SealStream /
// OpenStream do the incremental crypto; this module owns the covcom-side pieces
// the two clients share: the chunk size, the slice loop, and the re-exports.
//
// Why chunked: a single monolithic seal + base64 + JSON.stringify held the whole
// file (~4.6x its size) in one renderer and OOM'd the tab, and any frame over the
// broker's 16 MiB WS ceiling was dropped. One bounded frame per chunk keeps peak
// memory and per-frame size O(chunkSize) on both ends.

export { SealStream, OpenStream, XChaCha20Cipher } from 'leviathan-crypto';

// Plaintext chunk size, one chunk per `file-chunk` frame. Capped at 65536: the
// XChaCha20 WASM seals at most 65536 plaintext bytes per chunk (SealStream.push
// throws above it), so this is the largest valid value. base64 inflates 4/3, so
// a frame is ~87 KB on the wire, far under the broker's 16 MiB per-message cap.
export const FILE_CHUNK_SIZE = 65536;

// Drive the seal/send loop over a byte source. `read(offset, len)` returns that
// slice (Blob.slice on web, Bun.file slice on cli); the loop, final-chunk
// detection, and the zero-byte case live here so both clients share one wire
// shape. A zero-length file still yields exactly one final empty chunk, mirroring
// SealStream.finalize, so the receiver always sees a terminator.
export async function forEachChunk(
	read:      (offset: number, len: number) => Promise<Uint8Array>,
	size:      number,
	chunkSize: number,
	cb:        (chunk: Uint8Array, seq: number, final: boolean) => Promise<void> | void,
): Promise<void> {
	let offset = 0;
	let seq    = 0;
	do {
		const len   = Math.min(chunkSize, size - offset);
		const chunk = await read(offset, len);
		const final = offset + len >= size;
		await cb(chunk, seq, final);
		offset += len;
		seq++;
	} while (offset < size);
}

// Receiver credit/ack flow control. The broker is a dumb relay with no
// backpressure: when a receiver consumes slower than the sender sends, the
// server's per-socket buffer overflows Bun's ~16 MB cap and frames are dropped.
// So the receiver acks its consumed seq and the sender holds a bounded window
// ahead of the slowest receiver. WINDOW chunks (~5.5 MB on the wire) stays well
// under the relay cap; the receiver acks every ACK_INTERVAL chunks (twice per
// window) and on the final chunk, so credit advances ahead of any stall.
export const WINDOW       = 64;
export const ACK_INTERVAL = 32;

// Acks ride the existing opaque `relay` message rather than a new server type.
// Relay payloads are disambiguated by a 1-byte tag prefix: chain seeds (the
// only prior use) carry 0x00, file acks carry 0x01. The server forwards the
// payload as opaque base64, so this is a client-only change applied to web and
// cli in lockstep (a half-applied tag breaks the handshake, not just files).
export const RELAY_TAG_SEED     = 0x00;
export const RELAY_TAG_FILE_ACK = 0x01;

export function prefixTag(tag: number, body: Uint8Array): Uint8Array {
	const out = new Uint8Array(body.length + 1);
	out[0] = tag;
	out.set(body, 1);
	return out;
}

export function readRelayTag(payload: Uint8Array): { tag: number; body: Uint8Array } {
	return { tag: payload[0], body: payload.subarray(1) };
}

// Ack body is tiny JSON ({f: fileId, s: seq}) so it never JSON-collides with raw
// crypto seed bytes; the tag byte is the unambiguous discriminator, not a sniff.
export function encodeFileAck(fileId: string, seq: number): Uint8Array {
	return prefixTag(RELAY_TAG_FILE_ACK, new TextEncoder().encode(JSON.stringify({ f: fileId, s: seq })));
}

// Defensive: `body` is a peer-controlled relay payload, so malformed/hostile
// input must not throw into the caller (an unguarded throw here is a trivial
// remote DoS). On any parse failure return a sentinel both callers already
// ignore: fileId '' misses the sendingFiles map and seq -1 fails the ack guard.
export function decodeFileAck(body: Uint8Array): { fileId: string; seq: number } {
	try {
		const v = JSON.parse(new TextDecoder().decode(body)) as { f?: unknown; s?: unknown };
		const fileId = typeof v.f === 'string' ? v.f : '';
		const seq    = typeof v.s === 'number' && Number.isFinite(v.s) ? v.s : -1;
		return { fileId, seq };
	} catch {
		return { fileId: '', seq: -1 };
	}
}
