import { describe, expect, test } from 'bun:test';
import { armorInvite, INVITE_VERSION, qrMatrix, serializeInvite } from '@covcom/lib';
import { qrToSvg } from '../src/qr.ts';

// The encoder (qrMatrix) is tested in @covcom/lib; here we only cover the web
// SVG renderer, asserting it stays structurally faithful to the (separately
// decode-verified) matrix it draws.
function makeInvite(dns?: string): string {
	let secret = '';
	for (const b of new Uint8Array(16)) secret += String.fromCharCode(b);
	return armorInvite(serializeInvite({
		version: INVITE_VERSION,
		roomId: 'abcdefghijklmnopqrstuvwxyz012345',
		roomSecret: btoa(secret),
		dns,
	}));
}

describe('qrToSvg', () => {
	const QUIET = 4;

	test('viewBox spans the matrix plus a quiet zone on each side', () => {
		const invite = makeInvite();
		const dim    = qrMatrix(invite).length + QUIET * 2;
		const svg    = qrToSvg(invite);
		expect(svg.tagName.toLowerCase()).toBe('svg');
		expect(svg.getAttribute('viewBox')).toBe(`0 0 ${dim} ${dim}`);
	});

	test('draws a white background rect and a single black path', () => {
		const svg  = qrToSvg(makeInvite());
		const rect = svg.querySelector('rect');
		const path = svg.querySelector('path');
		expect(rect?.getAttribute('fill')).toBe('#ffffff');
		expect(path?.getAttribute('fill')).toBe('#000000');
		expect(svg.querySelectorAll('path').length).toBe(1);
	});

	test('path has exactly one move command per dark module', () => {
		for (const dns of [undefined, 'covcom.example.org']) {
			const invite = makeInvite(dns);
			const matrix = qrMatrix(invite);
			const dark   = matrix.reduce((n, row) => n + row.filter(Boolean).length, 0);
			const d      = qrToSvg(invite).querySelector('path')?.getAttribute('d') ?? '';
			expect((d.match(/M/g) ?? []).length).toBe(dark);
		}
	});

	test('throws when the invite is too large to encode', () => {
		expect(() => qrToSvg('x'.repeat(272))).toThrow(RangeError);
	});
});
