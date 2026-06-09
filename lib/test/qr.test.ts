import { describe, expect, test } from 'bun:test';
import { qrMatrix } from '../src/qr.js';

// Fixtures are authoritative outputs from the `qrcode` npm package (the same
// encoder the web client used to depend on), generated in byte mode at
// error-correction level L with an explicit version + mask, then packed
// row-major MSB-first as hex. They pin our encoder against a reference across
// the branches that matter: single-block (v1), multi-block + alignment patterns
// (v6), and version-info modules (v7). `qrcode` is not a dependency of this
// package, so the matrices are embedded rather than recomputed at test time.
interface Fixture {
	text:    string;
	version: number;
	mask:    number;
	size:    number;
	hex:     string;
}

const FIXTURES: Fixture[] = [
	{
		text: 'HELLO WORLD',
		version: 1,
		mask: 3,
		size: 21,
		hex: 'febbfc11906eb4bb7595dba92ec13d07faafe00300f2fceae9fb3ca547fa22ae34c2806997f8fe1040afba2a45d513aeba4905af1fe9500',
	},
	{
		text: '-----BEGIN COVCOM INVITE-----\naGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3QgcGF5bG9hZCBmb3IgcXIgxxxxxxxx\nZm9v\n-----END COVCOM INVITE-----\n',
		version: 6,
		mask: 4,
		size: 41,
		hex: 'fecaa1333fc1721916d06eacf7258bb7599cac45dba6b682c2ec1575921907faaaaaaafe00369f5c00ce5d4df097847deb9b544e98f04d273a0d5de69513b061bb4c524a598c29f67be52f69ef8aa2bf38e9aa2d4d10cfe03871da8cd8a74b653971893bd6bb20b4f1c9c0d58138aecbd72a943e6bbf1b92eb7a214339dfd1c9ea59c13b8c07c7cbdd3b3d8e98c2a08e6c41afdcf5ea5bafe0e49a6d1ff2763962fb7f3bfe8017d1fc0053f88ac73f8e72f52ab0547f82b18bace12adfe5d1248fca62e8962ffc8505d6bf398bfe92cb10db0',
	},
	{
		text: '-----BEGIN COVCOM INVITE-----\nqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq\nzzzzzzzzzzzzzzzzzzzzzzzzzzzz\n-----END COVCOM INVITE-----\n',
		version: 7,
		mask: 0,
		size: 45,
		hex: 'fe10fd7bcbfc13e241a6906ea5fce444bb74011ecc35dba35dfe67aec1250c5dc107faaaaaaaafe0152d19ff00efb2eff8ee228572ac000acc88abb34aba831000dde90db1f751997d78e5194cc0154ff6df1113fcac2489b7b8b693f8fe848ca3b2ac008ec68eebb35edad94300ddd90dfef6f998fd34611c4ccc55aa572b112be91c2719b3105ffafffe9fac07b2540082c0ce89534bfaa2a020ddf608a576f9984d3431128cc5269ff729115e72922329bd30ee0ba67ee32c21735c0082c2b889d35bfaf11120ddf629b176f998fc00411c4cc447fb76ab116bf05e2919b310baeaeffeafadd1a2c0004a2eb0ecb36e7905731addc12fef77e998bd8',
	},
];

function unpack(hex: string, size: number): boolean[][] {
	const m: boolean[][] = [];
	for (let y = 0; y < size; y++) {
		const row: boolean[] = [];
		for (let x = 0; x < size; x++) {
			const idx = y * size + x;
			const nib = parseInt(hex[idx >> 2], 16);
			row.push(((nib >> (3 - (idx & 3))) & 1) === 1);
		}
		m.push(row);
	}
	return m;
}

describe('qrMatrix encoding', () => {
	for (const fx of FIXTURES) {
		test(`matches qrcode reference (v${fx.version}, mask ${fx.mask})`, () => {
			const got      = qrMatrix(fx.text, { version: fx.version, mask: fx.mask });
			const expected = unpack(fx.hex, fx.size);
			expect(got.length).toBe(fx.size);
			expect(got).toEqual(expected);
		});
	}

	test('auto-selects the smallest fitting version', () => {
		// 17-byte string is the v1 byte-mode L ceiling (4 + 8 + 17*8 == 152 bits).
		expect(qrMatrix('x'.repeat(17)).length).toBe(21); // v1
		expect(qrMatrix('x'.repeat(18)).length).toBe(25); // v2
	});

	test('auto path produces a square matrix with finder patterns in all corners', () => {
		const m    = qrMatrix('-----BEGIN COVCOM INVITE-----\n' + 'a'.repeat(64) + '\n-----END COVCOM INVITE-----\n');
		const size = m.length;
		expect(m.every(r => r.length === size)).toBe(true);
		// finder rings (by Chebyshev distance from centre): 0-1 dark core,
		// 2 light separator ring, 3 dark outer border.
		for (const [cy, cx] of [[3, 3], [3, size - 4], [size - 4, 3]]) {
			expect(m[cy][cx]).toBe(true);      // centre, dist 0
			expect(m[cy + 1][cx]).toBe(true);  // dist 1, dark core
			expect(m[cy + 2][cx]).toBe(false); // dist 2, light ring
		}
	});

	test('throws when the payload exceeds the supported version range', () => {
		expect(() => qrMatrix('x'.repeat(272))).toThrow(RangeError);
	});
});
