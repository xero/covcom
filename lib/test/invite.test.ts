import { describe, expect, test } from 'bun:test';
import { INVITE_VERSION, armorInvite, inviteFilename, parseArmoredInvite, serializeInvite } from '../src/invite.js';
import type { InvitePayload } from '../src/types.js';

function makeRoomSecret(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

function roundTrip(payload: InvitePayload): InvitePayload {
	return parseArmoredInvite(armorInvite(serializeInvite(payload)));
}

describe('invite serialization', () => {
	test('1. round-trip without dns', () => {
		const payload: InvitePayload = {
			version: INVITE_VERSION,
			roomId: 'abcdefghijklmnopqrstuvwxyz123456',
			roomSecret: makeRoomSecret(),
		};
		const parsed = roundTrip(payload);
		expect(parsed.version).toBe(INVITE_VERSION);
		expect(parsed.roomId).toBe(payload.roomId);
		expect(parsed.roomSecret).toBe(payload.roomSecret);
		expect(parsed.dns).toBeUndefined();
	});

	test('2. round-trip with dns', () => {
		const payload: InvitePayload = {
			version: INVITE_VERSION,
			roomId: 'abcdefghijklmnopqrstuvwxyz123456',
			roomSecret: makeRoomSecret(),
			dns: 'chat.example.com',
		};
		const parsed = roundTrip(payload);
		expect(parsed.dns).toBe('chat.example.com');
		expect(parsed.roomSecret).toBe(payload.roomSecret);
	});

	test('3. roomSecret round-trip preserves bytes', () => {
		const payload: InvitePayload = {
			version: INVITE_VERSION,
			roomId: 'abcdefghijklmnopqrstuvwxyz123456',
			roomSecret: makeRoomSecret(),
		};
		const result   = roundTrip(payload);
		const original = Uint8Array.from(atob(payload.roomSecret), c => c.charCodeAt(0));
		const parsed   = Uint8Array.from(atob(result.roomSecret),  c => c.charCodeAt(0));
		expect(parsed).toEqual(original);
	});

	test('4. parse from surrounded text', () => {
		const payload: InvitePayload = {
			version: INVITE_VERSION,
			roomId: 'abcdefghijklmnopqrstuvwxyz123456',
			roomSecret: makeRoomSecret(),
		};
		const armored = armorInvite(serializeInvite(payload));
		const wrapped = `Here is your invite:\n\n${armored}\n\nThanks!`;
		const parsed  = parseArmoredInvite(wrapped);
		expect(parsed.roomId).toBe(payload.roomId);
		expect(parsed.roomSecret).toBe(payload.roomSecret);
	});

	test('5. inviteFilename', () => {
		expect(inviteFilename('abc123')).toBe('covcom-abc123.room');
	});

	test('6. unknown version byte throws', () => {
		const payload: InvitePayload = {
			version: INVITE_VERSION,
			roomId: 'abcdefghijklmnopqrstuvwxyz123456',
			roomSecret: makeRoomSecret(),
		};
		const binary = serializeInvite(payload);
		binary[0] = 0x02;
		expect(() => parseArmoredInvite(armorInvite(binary))).toThrow('0x02');
	});

	test('7. truncated buffer throws', () => {
		const buf = new Uint8Array(30);
		expect(() => parseArmoredInvite(armorInvite(buf))).toThrow();
	});

	test('8. roomId wrong length throws RangeError', () => {
		expect(
			() =>
				serializeInvite({
					version: INVITE_VERSION,
					roomId: 'short',
					roomSecret: makeRoomSecret(),
				}),
		).toThrow(RangeError);
	});

	test('9. roomSecret wrong byte count throws RangeError', () => {
		const bytes = crypto.getRandomValues(new Uint8Array(15));
		let s = '';
		for (const b of bytes) s += String.fromCharCode(b);
		const badSecret = btoa(s);
		expect(
			() =>
				serializeInvite({
					version: INVITE_VERSION,
					roomId: 'abcdefghijklmnopqrstuvwxyz123456',
					roomSecret: badSecret,
				}),
		).toThrow(RangeError);
	});
});
