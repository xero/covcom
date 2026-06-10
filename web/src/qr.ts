import { qrMatrix } from '@covcom/lib';

const SVG_NS = 'http://www.w3.org/2000/svg';
const QUIET  = 4; // spec quiet-zone width, in modules

// Render an invite as an inline SVG QR using the shared encoder in
// @covcom/lib. The dark modules collapse into a single black <path> over a
// white background rect; forced black-on-white (independent of theme) keeps it
// scannable, matching the cli renderer. Crisp at any size since the SVG is
// vector and scaled via CSS. Throws RangeError when the invite is too large to
// encode, so the caller can omit the QR.
export function qrToSvg(data: string): SVGSVGElement {
	const matrix = qrMatrix(data);
	const size = matrix.length;
	const dim = size + QUIET * 2;

	let d = '';
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			if (matrix[y][x]) d += `M${x + QUIET},${y + QUIET}h1v1h-1z`;
		}
	}

	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', `0 0 ${dim} ${dim}`);
	svg.setAttribute('shape-rendering', 'crispEdges');

	const bg = document.createElementNS(SVG_NS, 'rect');
	bg.setAttribute('width', String(dim));
	bg.setAttribute('height', String(dim));
	bg.setAttribute('fill', '#ffffff');

	const path = document.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', d);
	path.setAttribute('fill', '#000000');

	svg.append(bg, path);
	return svg;
}
