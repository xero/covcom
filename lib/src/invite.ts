import type { InvitePayload } from './types.js';

const BEGIN = '-----BEGIN COVCOM INVITE-----';
const END   = '-----END COVCOM INVITE-----';

export const INVITE_VERSION = 0x01;

function _decodeBase64(s: string): Uint8Array {
	return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

function _encodeBase64(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

export function serializeInvite(payload: InvitePayload): Uint8Array {
	const enc         = new TextEncoder();
	const roomIdBytes = enc.encode(payload.roomId);
	if (roomIdBytes.length !== 32)
		throw new RangeError(`roomId must encode to 32 bytes, got ${roomIdBytes.length}`);

	const secretBytes = _decodeBase64(payload.roomSecret);
	if (secretBytes.length !== 16)
		throw new RangeError(`roomSecret must decode to 16 bytes, got ${secretBytes.length}`);

	const dnsBytes = payload.dns !== undefined ? enc.encode(payload.dns) : null;
	const size     = 49 + (dnsBytes ? dnsBytes.length : 0);
	const buf      = new Uint8Array(size);

	buf[0] = INVITE_VERSION;
	buf.set(roomIdBytes, 1);
	buf.set(secretBytes, 33);
	if (dnsBytes) buf.set(dnsBytes, 49);

	return buf;
}

export function armorInvite(binary: Uint8Array): string {
	let s = '';
	for (const byte of binary) s += String.fromCharCode(byte);
	const b64 = btoa(s);
	const lines: string[] = [];
	for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
	return `${BEGIN}\n${lines.join('\n')}\n${END}\n`;
}

export function parseArmoredInvite(text: string): InvitePayload {
	const s = text.indexOf(BEGIN);
	const e = text.indexOf(END);
	if (s === -1 || e === -1 || e <= s) throw new Error('No armor markers found in input');

	const b64 = text.slice(s + BEGIN.length, e).replace(/\s/g, '');
	let binStr: string;
	try {
		binStr = atob(b64);
	} catch {
		throw new Error('Invalid base64 in armor block');
	}

	const binary = new Uint8Array(binStr.length);
	for (let i = 0; i < binStr.length; i++) binary[i] = binStr.charCodeAt(i);

	return _deserialize(binary);
}

export function inviteFilename(roomId: string): string {
	return `covcom-${roomId}.room`;
}

function _deserialize(buf: Uint8Array): InvitePayload {
	if (buf.length < 49) throw new Error('Invite payload truncated');

	const version = buf[0];
	if (version !== INVITE_VERSION)
		throw new Error(`Unsupported invite version: 0x${version.toString(16).padStart(2, '0')}`);

	const roomId     = new TextDecoder().decode(buf.slice(1, 33));
	const roomSecret = _encodeBase64(buf.slice(33, 49));
	const dns        = buf.length > 49
		? new TextDecoder().decode(buf.slice(49))
		: undefined;

	return { version, roomId, roomSecret, dns };
}
