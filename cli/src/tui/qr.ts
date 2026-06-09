// Terminal renderer for the shared QR encoder in @covcom/lib (qrMatrix). The
// encoding lives in lib so the web and cli clients share one audited
// implementation; only the rendering differs.

// Render a module matrix to terminal rows using half-block glyphs: each text
// row packs two module rows (upper/lower half), so a 41x41 QR becomes 41 cols
// by 21 rows. A `margin`-module light quiet zone is added on all sides. Rows
// contain only glyphs; the caller applies a fixed light background and dark
// foreground for scanner contrast.
export function qrHalfBlock(matrix: boolean[][], margin = 2): string[] {
	const inner = matrix.length;
	const span  = inner + margin * 2;
	const dark  = (x: number, y: number): boolean => {
		const mx = x - margin;
		const my = y - margin;
		if (mx < 0 || my < 0 || mx >= inner || my >= inner) return false;
		return matrix[my][mx];
	};

	const rows: string[] = [];
	for (let y = 0; y < span; y += 2) {
		let line = '';
		for (let x = 0; x < span; x++) {
			const top = dark(x, y);
			const bot = y + 1 < span && dark(x, y + 1);
			line += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' ';
		}
		rows.push(line);
	}
	return rows;
}
