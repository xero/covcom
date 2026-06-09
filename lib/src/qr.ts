// Zero-dependency QR encoder shared by the web and cli clients, scoped to
// exactly what covcom invites need: byte mode, error-correction level L,
// versions 1-10. Our armored invites are ~128-160 bytes, which land at version
// 6-8; v10 (271-byte L capacity) is the supported ceiling. Anything larger
// throws so the caller can fall back to hiding the QR.
//
// It returns a raw module matrix; rendering lives with each client (the cli
// draws half-block glyphs, the web draws an SVG). The pipeline is the standard
// ISO/IEC 18004 flow: encode -> Reed-Solomon -> interleave -> place modules ->
// mask -> stamp format/version info. Constants (codeword counts, block
// structure, alignment positions) are the level-L rows of the spec tables.

interface VersionInfo {
	totalCw:    number;
	blocks:     number;
	ecPerBlock: number;
	align:      number[];
}

// Index 0 == version 1. dataCw == totalCw - blocks * ecPerBlock.
const VERSIONS: VersionInfo[] = [
	{ totalCw: 26,  blocks: 1, ecPerBlock: 7,  align: [] },
	{ totalCw: 44,  blocks: 1, ecPerBlock: 10, align: [6, 18] },
	{ totalCw: 70,  blocks: 1, ecPerBlock: 15, align: [6, 22] },
	{ totalCw: 100, blocks: 1, ecPerBlock: 20, align: [6, 26] },
	{ totalCw: 134, blocks: 1, ecPerBlock: 26, align: [6, 30] },
	{ totalCw: 172, blocks: 2, ecPerBlock: 18, align: [6, 34] },
	{ totalCw: 196, blocks: 2, ecPerBlock: 20, align: [6, 22, 38] },
	{ totalCw: 242, blocks: 2, ecPerBlock: 24, align: [6, 24, 42] },
	{ totalCw: 292, blocks: 2, ecPerBlock: 30, align: [6, 26, 46] },
	{ totalCw: 346, blocks: 4, ecPerBlock: 18, align: [6, 28, 50] },
];

const ECL_FORMAT_BITS = 1; // level L

function dataCw(v: VersionInfo): number {
	return v.totalCw - v.blocks * v.ecPerBlock;
}

// GF(256) multiply with the QR primitive polynomial 0x11d.
function gfMul(x: number, y: number): number {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z & 0xff;
}

function rsDivisor(degree: number): number[] {
	const result = new Array(degree).fill(0);
	result[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < degree; j++) {
			result[j] = gfMul(result[j], root);
			if (j + 1 < degree) result[j] ^= result[j + 1];
		}
		root = gfMul(root, 0x02);
	}
	return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
	const result = new Array(divisor.length).fill(0);
	for (const b of data) {
		const factor = b ^ (result.shift() ?? 0);
		result.push(0);
		for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
	}
	return result;
}

function getBit(x: number, i: number): boolean {
	return ((x >>> i) & 1) !== 0;
}

// Pick the smallest supported version whose level-L byte-mode capacity holds
// `byteLen` data bytes, or null when even v10 is too small.
function chooseVersion(byteLen: number): number | null {
	for (let v = 1; v <= VERSIONS.length; v++) {
		const ccBits = v < 10 ? 8 : 16;
		const usedBits = 4 + ccBits + byteLen * 8;
		if (usedBits <= dataCw(VERSIONS[v - 1]) * 8) return v;
	}
	return null;
}

// Build the bitstream and pad it out to the version's data-codeword budget.
function buildDataCodewords(bytes: Uint8Array, version: number): number[] {
	const info     = VERSIONS[version - 1];
	const capacity = dataCw(info) * 8;
	const ccBits   = version < 10 ? 8 : 16;
	const bits: boolean[] = [];

	const append = (value: number, len: number): void => {
		for (let i = len - 1; i >= 0; i--) bits.push(getBit(value, i));
	};

	append(0b0100, 4);          // byte mode
	append(bytes.length, ccBits);
	for (const b of bytes) append(b, 8);

	append(0, Math.min(4, capacity - bits.length));      // terminator
	if (bits.length % 8 !== 0) append(0, 8 - (bits.length % 8)); // byte align

	const words: number[] = [];
	for (let i = 0; i < bits.length; i += 8) {
		let byte = 0;
		for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ? 1 : 0);
		words.push(byte);
	}
	for (let pad = 0xec; words.length < dataCw(info); pad ^= 0xec ^ 0x11) words.push(pad);
	return words;
}

// Split data codewords into blocks, append per-block EC, and interleave both
// halves per the spec's column-major ordering.
function addEccAndInterleave(data: number[], version: number): number[] {
	const info          = VERSIONS[version - 1];
	const numBlocks     = info.blocks;
	const ecLen         = info.ecPerBlock;
	const rawCodewords  = info.totalCw;
	const numShort      = numBlocks - (rawCodewords % numBlocks);
	const shortLen      = Math.floor(rawCodewords / numBlocks);
	const divisor       = rsDivisor(ecLen);

	const blocks: number[][] = [];
	let k = 0;
	for (let i = 0; i < numBlocks; i++) {
		const datLen = shortLen - ecLen + (i < numShort ? 0 : 1);
		const dat    = data.slice(k, k + datLen);
		k += datLen;
		const ecc = rsRemainder(dat, divisor);
		if (i < numShort) dat.push(0); // pad short blocks to align the matrix walk
		blocks.push(dat.concat(ecc));
	}

	const result: number[] = [];
	for (let i = 0; i < blocks[0].length; i++) {
		for (let j = 0; j < blocks.length; j++) {
			// the padding byte added to short blocks is skipped on output
			if (i !== shortLen - ecLen || j >= numShort) result.push(blocks[j][i]);
		}
	}
	return result;
}

class QrBuilder {
	readonly size:    number;
	readonly modules: boolean[][];
	private  isFn:    boolean[][];

	constructor(private readonly version: number) {
		this.size    = 17 + 4 * version;
		this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
		this.isFn    = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
	}

	private set(x: number, y: number, dark: boolean): void {
		this.modules[y][x] = dark;
		this.isFn[y][x]    = true;
	}

	private drawFinder(cx: number, cy: number): void {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const x = cx + dx;
				const y = cy + dy;
				if (x < 0 || x >= this.size || y < 0 || y >= this.size) continue;
				const dist = Math.max(Math.abs(dx), Math.abs(dy));
				this.set(x, y, dist !== 2 && dist <= 3);
			}
		}
	}

	private drawAlignment(cx: number, cy: number): void {
		for (let dy = -2; dy <= 2; dy++) {
			for (let dx = -2; dx <= 2; dx++) {
				this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
			}
		}
	}

	private drawFunctionPatterns(): void {
		for (let i = 0; i < this.size; i++) {
			this.set(6, i, i % 2 === 0);
			this.set(i, 6, i % 2 === 0);
		}
		this.drawFinder(3, 3);
		this.drawFinder(this.size - 4, 3);
		this.drawFinder(3, this.size - 4);

		const pos = VERSIONS[this.version - 1].align;
		const n   = pos.length;
		for (let i = 0; i < n; i++) {
			for (let j = 0; j < n; j++) {
				const skipCorner = (i === 0 && j === 0)
					|| (i === 0 && j === n - 1)
					|| (i === n - 1 && j === 0);
				if (!skipCorner) this.drawAlignment(pos[i], pos[j]);
			}
		}

		this.drawFormat(0);
		this.drawVersion();
	}

	private drawFormat(mask: number): void {
		const data = (ECL_FORMAT_BITS << 3) | mask;
		let rem = data;
		for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		const bits = ((data << 10) | rem) ^ 0x5412;

		for (let i = 0; i <= 5; i++) this.set(8, i, getBit(bits, i));
		this.set(8, 7, getBit(bits, 6));
		this.set(8, 8, getBit(bits, 7));
		this.set(7, 8, getBit(bits, 8));
		for (let i = 9; i < 15; i++) this.set(14 - i, 8, getBit(bits, i));

		for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, getBit(bits, i));
		for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, getBit(bits, i));
		this.set(8, this.size - 8, true); // always-dark module
	}

	private drawVersion(): void {
		if (this.version < 7) return;
		let rem = this.version;
		for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		const bits = (this.version << 12) | rem;
		for (let i = 0; i < 18; i++) {
			const bit = getBit(bits, i);
			const a   = this.size - 11 + (i % 3);
			const b   = Math.floor(i / 3);
			this.set(a, b, bit);
			this.set(b, a, bit);
		}
	}

	private drawCodewords(codewords: number[]): void {
		let i = 0;
		for (let right = this.size - 1; right >= 1; right -= 2) {
			if (right === 6) right = 5;
			for (let vert = 0; vert < this.size; vert++) {
				for (let j = 0; j < 2; j++) {
					const x       = right - j;
					const upward  = ((right + 1) & 2) === 0;
					const y       = upward ? this.size - 1 - vert : vert;
					if (!this.isFn[y][x] && i < codewords.length * 8) {
						this.modules[y][x] = getBit(codewords[i >>> 3], 7 - (i & 7));
						i++;
					}
				}
			}
		}
	}

	private maskCondition(mask: number, x: number, y: number): boolean {
		switch (mask) {
		case 0:  return (x + y) % 2 === 0;
		case 1:  return y % 2 === 0;
		case 2:  return x % 3 === 0;
		case 3:  return (x + y) % 3 === 0;
		case 4:  return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
		case 5:  return ((x * y) % 2) + ((x * y) % 3) === 0;
		case 6:  return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
		default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
		}
	}

	private applyMask(mask: number): void {
		for (let y = 0; y < this.size; y++) {
			for (let x = 0; x < this.size; x++) {
				if (!this.isFn[y][x] && this.maskCondition(mask, x, y)) {
					this.modules[y][x] = !this.modules[y][x];
				}
			}
		}
	}

	private penalty(): number {
		const size = this.size;
		const m    = this.modules;
		let result = 0;
		const N1 = 3, N2 = 3, N3 = 40, N4 = 10;

		const countFinder = (h: number[]): number => {
			const n    = h[1];
			const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
			return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0)
				+ (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
		};
		const addHistory = (run: number, h: number[]): void => {
			if (h[0] === 0) run += size;
			h.pop();
			h.unshift(run);
		};

		for (let y = 0; y < size; y++) {
			let runColor = false, runLen = 0;
			const hist = [0, 0, 0, 0, 0, 0, 0];
			for (let x = 0; x < size; x++) {
				if (m[y][x] === runColor) {
					runLen++;
					if (runLen === 5) result += N1;
					else if (runLen > 5) result++;
				} else {
					addHistory(runLen, hist);
					if (!runColor) result += countFinder(hist) * N3;
					runColor = m[y][x];
					runLen   = 1;
				}
			}
			if (runColor) addHistory(runLen, hist);
			addHistory(size, hist);
			result += countFinder(hist) * N3;
		}
		for (let x = 0; x < size; x++) {
			let runColor = false, runLen = 0;
			const hist = [0, 0, 0, 0, 0, 0, 0];
			for (let y = 0; y < size; y++) {
				if (m[y][x] === runColor) {
					runLen++;
					if (runLen === 5) result += N1;
					else if (runLen > 5) result++;
				} else {
					addHistory(runLen, hist);
					if (!runColor) result += countFinder(hist) * N3;
					runColor = m[y][x];
					runLen   = 1;
				}
			}
			if (runColor) addHistory(runLen, hist);
			addHistory(size, hist);
			result += countFinder(hist) * N3;
		}

		for (let y = 0; y < size - 1; y++) {
			for (let x = 0; x < size - 1; x++) {
				const c = m[y][x];
				if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += N2;
			}
		}

		let dark = 0;
		for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (m[y][x]) dark++;
		const total = size * size;
		const k     = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
		result += k * N4;
		return result;
	}

	build(codewords: number[], forcedMask: number | null): boolean[][] {
		this.drawFunctionPatterns();
		this.drawCodewords(codewords);

		let chosen = forcedMask;
		if (chosen === null) {
			let best = -1;
			for (let mask = 0; mask < 8; mask++) {
				this.applyMask(mask);
				this.drawFormat(mask);
				const score = this.penalty();
				this.applyMask(mask); // undo
				if (best === -1 || score < best) {
					best   = score;
					chosen = mask;
				}
			}
		}
		const mask = chosen ?? 0;
		this.applyMask(mask);
		this.drawFormat(mask);
		return this.modules;
	}
}

export interface QrOptions {
	version?: number;
	mask?:    number;
}

// Encode `data` as a QR module matrix (true == dark). Throws RangeError when
// the payload exceeds the supported version range.
export function qrMatrix(data: string, opts: QrOptions = {}): boolean[][] {
	const bytes   = new TextEncoder().encode(data);
	const version = opts.version ?? chooseVersion(bytes.length);
	if (version === null || version < 1 || version > VERSIONS.length) {
		throw new RangeError(`invite too large for QR (max version ${VERSIONS.length})`);
	}
	const dataWords = buildDataCodewords(bytes, version);
	const codewords = addEccAndInterleave(dataWords, version);
	return new QrBuilder(version).build(codewords, opts.mask ?? null);
}
