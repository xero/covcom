import { describe, expect, test } from 'bun:test';
import { qrMatrix } from '@covcom/lib';
import { qrHalfBlock } from '../src/tui/qr.ts';

// The encoder (qrMatrix) is tested in @covcom/lib; here we only cover the
// terminal half-block renderer. A v1 matrix from a fixed input gives a stable
// shape to assert against.
describe('qrHalfBlock rendering', () => {
	const matrix = qrMatrix('HELLO WORLD', { version: 1, mask: 3 });

	test('packs two module rows per line and adds a quiet zone', () => {
		const margin = 2;
		const rows   = qrHalfBlock(matrix, margin);
		const span   = matrix.length + margin * 2; // 21 + 4 == 25
		expect(rows.length).toBe(Math.ceil(span / 2));
		expect(rows.every(r => [...r].length === span)).toBe(true);
	});

	test('only emits half-block glyphs and spaces', () => {
		const allowed = new Set(['█', '▀', '▄', ' ']);
		for (const row of qrHalfBlock(matrix)) {
			for (const ch of row) expect(allowed.has(ch)).toBe(true);
		}
	});

	test('quiet-zone border rows and columns are light', () => {
		const margin = 2;
		const rows   = qrHalfBlock(matrix, margin);
		expect(rows[0]).toMatch(/^ +$/);                 // top margin row (2 light module rows)
		for (const row of rows) {
			expect(row.slice(0, margin)).toBe(' '.repeat(margin));   // left quiet zone
			expect(row.slice(-margin)).toBe(' '.repeat(margin));     // right quiet zone
		}
	});
});
