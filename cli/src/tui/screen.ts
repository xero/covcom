export type ColorValue =
	| { type: 'ansi16'; n: number }
	| { type: '256';    n: number }
	| { type: 'hex';    value: string }
	| null

export interface Theme {
	bg:            ColorValue
	fg:            ColorValue
	inputBg:       ColorValue
	inputFg:       ColorValue
	btnBg:         ColorValue
	btnFg:         ColorValue
	btnFocusBg:    ColorValue
	btnFocusFg:    ColorValue
	btnDisabledBg: ColorValue
	btnDisabledFg: ColorValue
	barBg:         ColorValue
	barFg:         ColorValue
	barBtnBg:      ColorValue
	barBtnFg:      ColorValue
	barBtnFocusBg: ColorValue
	barBtnFocusFg: ColorValue
	yourMsg:       ColorValue
	peer0:         ColorValue
	peer1:         ColorValue
	peer2:         ColorValue
	peer3:         ColorValue
	peer4:         ColorValue
	peer5:         ColorValue
	peer6:         ColorValue
	peer7:         ColorValue
	peerMsg:       ColorValue
	attachBg:         ColorValue
	attachFg:         ColorValue
	attachSelectedBg: ColorValue
	attachSelectedFg: ColorValue
	barAttach:        ColorValue
	calloutBg:     ColorValue
	calloutFg:     ColorValue
	modalBg:       ColorValue
	modalFg:       ColorValue
	modalBorder:   ColorValue
	modalTitle:    ColorValue
	disabled:      ColorValue
	system:        ColorValue
	error:         ColorValue
	evtTime:        ColorValue
	evtArrow:       ColorValue
	evtMsg:         ColorValue
	evtKey:         ColorValue
	evtVal:         ColorValue
	evtSelf:        ColorValue
	evtPeer:        ColorValue
	evtKindDefault: ColorValue
	evtKindError:   ColorValue
	evtKindMember:  ColorValue
	evtKindRatchet: ColorValue
	codeFg:         ColorValue
	codeBg:         ColorValue
	keyFg:          ColorValue
	ratchetTxtFg:   ColorValue
}

export const defaultTheme: Theme = {
	bg: null,
	fg: null,
	inputBg: { type: 'ansi16', n: 0  },
	inputFg: { type: 'ansi16', n: 15 },
	btnBg: { type: 'ansi16', n: 8  },
	btnFg: { type: 'ansi16', n: 15 },
	btnFocusBg: { type: 'ansi16', n: 4  },
	btnFocusFg: { type: 'ansi16', n: 15 },
	btnDisabledBg: { type: 'ansi16', n: 8  },
	btnDisabledFg: { type: 'ansi16', n: 8  },
	barBg: { type: 'ansi16', n: 8  },
	barFg: { type: 'ansi16', n: 15 },
	barBtnBg: { type: 'ansi16', n: 8  },
	barBtnFg: { type: 'ansi16', n: 15 },
	barBtnFocusBg: { type: 'ansi16', n: 4  },
	barBtnFocusFg: { type: 'ansi16', n: 15 },
	yourMsg: { type: 'ansi16', n: 7  },
	peer0: { type: 'ansi16', n: 10 },
	peer1: { type: 'ansi16', n: 14 },
	peer2: { type: 'ansi16', n: 12 },
	peer3: { type: 'ansi16', n: 13 },
	peer4: { type: 'ansi16', n: 11 },
	peer5: { type: 'ansi16', n: 9  },
	peer6: { type: 'ansi16', n: 5  },
	peer7: { type: 'ansi16', n: 2  },
	peerMsg: { type: 'ansi16', n: 15 },
	attachBg: { type: 'ansi16', n: 6  },
	attachFg: { type: 'ansi16', n: 0  },
	attachSelectedBg: { type: 'ansi16', n: 2  },
	attachSelectedFg: { type: 'ansi16', n: 0  },
	barAttach: { type: 'ansi16', n: 6  },
	calloutBg: { type: 'ansi16', n: 3  },
	calloutFg: { type: 'ansi16', n: 0  },
	modalBg: { type: 'ansi16', n: 0  },
	modalFg: { type: 'ansi16', n: 15 },
	modalBorder: { type: 'ansi16', n: 6  },
	modalTitle: { type: 'ansi16', n: 14 },
	disabled: { type: 'ansi16', n: 8  },
	system: { type: '256', n: 250 },
	error: { type: 'ansi16', n: 9  },
	evtTime: { type: 'ansi16', n: 8  },
	evtArrow: { type: 'ansi16', n: 15 },
	evtMsg: { type: 'ansi16', n: 15 },
	evtKey: { type: 'ansi16', n: 8  },
	evtVal: { type: 'ansi16', n: 15 },
	evtSelf: { type: 'ansi16', n: 5  },
	evtPeer: { type: 'ansi16', n: 6  },
	evtKindDefault: { type: 'ansi16', n: 4 },
	evtKindError: { type: 'ansi16', n: 1   },
	evtKindMember: { type: 'ansi16', n: 2  },
	evtKindRatchet: { type: 'ansi16', n: 3 },
	codeFg: { type: 'ansi16', n: 15 },
	codeBg: { type: 'ansi16', n: 8  },
	keyFg: { type: 'ansi16', n: 3 },
	ratchetTxtFg: { type: 'ansi16', n: 8 },
};

function parseHex(hex: string): [number, number, number] {
	const h = hex.replace('#', '');
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export const ansi = {
	reset: '\x1b[0m',
	bold: '\x1b[1m',
	dim: '\x1b[2m',
	italic: '\x1b[3m',
	fg(n: number): string {
		return n < 8 ? `\x1b[${30 + n}m` : `\x1b[${90 + n - 8}m`;
	},
	bg(n: number): string {
		return n < 8 ? `\x1b[${40 + n}m` : `\x1b[${100 + n - 8}m`;
	},
	fgHex(hex: string): string {
		const [r, g, b] = parseHex(hex);
		return `\x1b[38;2;${r};${g};${b}m`;
	},
	bgHex(hex: string): string {
		const [r, g, b] = parseHex(hex);
		return `\x1b[48;2;${r};${g};${b}m`;
	},
} as const;

export function colorFg(cv: ColorValue): string {
	if (!cv) return '';
	if (cv.type === 'ansi16') return ansi.fg(cv.n);
	if (cv.type === '256') return `\x1b[38;5;${cv.n}m`;
	return ansi.fgHex(cv.value);
}

export function colorBg(cv: ColorValue): string {
	if (!cv) return '';
	if (cv.type === 'ansi16') return ansi.bg(cv.n);
	if (cv.type === '256') return `\x1b[48;5;${cv.n}m`;
	return ansi.bgHex(cv.value);
}

// Map a peer's 1-based colorIdx (assigned by join order) to one of the 7 shared
// peer colors peer1..peer7, wrapping after 7. Slot peer0 is reserved for self
// and is never returned here, so a peer can never wear your color (nor the
// separate system/disabled color). Self is rendered with theme.peer0 directly.
export function peerColor(theme: Theme, colorIdx: number): ColorValue {
	const slots = [
		theme.peer1, theme.peer2, theme.peer3, theme.peer4,
		theme.peer5, theme.peer6, theme.peer7,
	];
	return slots[Math.max(0, colorIdx - 1) % 7];
}

export class Screen {
	w = 80;
	h = 24;
	private dirty = true;

	constructor() {
		process.stdout.write('\x1b[?1049h');
		process.stdout.write('\x1b[?25l');
		process.stdout.write('\x1b[?1006h');
		process.stdout.write('\x1b[?1000h');
		process.stdout.write('\x1b[?2004h');
		process.stdin.setRawMode(true);
		process.stdin.resume();
		this.measure();
		process.stdout.on('resize', () => {
			this.measure(); this.markDirty();
		});
	}

	measure() {
		this.w = process.stdout.columns || 80;
		this.h = process.stdout.rows    || 24;
	}

	moveTo(x: number, y: number) {
		process.stdout.write(`\x1b[${y};${x}H`);
	}

	fillRect(x: number, y: number, w: number, h: number, bg: ColorValue) {
		const bgSeq = colorBg(bg);
		const row   = ' '.repeat(Math.max(0, w));
		for (let r = 0; r < h; r++) {
			this.moveTo(x, y + r);
			process.stdout.write(bgSeq + row + ansi.reset);
		}
	}

	write(s: string)     {
		process.stdout.write(s);
	}
	markDirty()          {
		this.dirty = true;
	}
	needsRender(): boolean {
		if (!this.dirty) return false;
		this.dirty = false;
		return true;
	}

	beginRender() {
		process.stdout.write('\x1b[?2026h');
	}
	endRender()   {
		process.stdout.write('\x1b[?2026l');
	}
	clear()       {
		process.stdout.write('\x1b[2J');
	}

	showCursor(x: number, y: number) {
		this.moveTo(x, y);
		process.stdout.write('\x1b[?25h');
	}

	hideCursor() {
		process.stdout.write('\x1b[?25l');
	}

	destroy() {
		process.stdout.write('\x1b[?25h');
		process.stdout.write('\x1b[?1049l');
		process.stdout.write('\x1b[?1006l');
		process.stdout.write('\x1b[?1000l');
		process.stdout.write('\x1b[?2004l');
		process.stdin.setRawMode(false);
	}
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// A theme value is valid when it is null (terminal default) or a well-formed
// color object: ansi16 with n in 0..15, 256 with n in 0..255, or hex #RRGGBB.
function isValidColor(cv: unknown): cv is ColorValue {
	if (cv === null) return true;
	if (typeof cv !== 'object') return false;
	const c = cv as { type?: unknown; n?: unknown; value?: unknown };
	if (c.type === 'ansi16') return typeof c.n === 'number' && Number.isInteger(c.n) && c.n >= 0 && c.n <= 15;
	if (c.type === '256')    return typeof c.n === 'number' && Number.isInteger(c.n) && c.n >= 0 && c.n <= 255;
	if (c.type === 'hex')    return typeof c.value === 'string' && HEX_RE.test(c.value);
	return false;
}

// Merge overrides over the defaults, but only for known theme keys that hold a
// valid color. Invalid values fall back to the default so a typo can never reach
// the terminal as a broken escape. Unknown keys (e.g. _comment keys) are ignored.
export function loadTheme(config: { theme?: Partial<Theme> }): Theme {
	const out = { ...defaultTheme };
	const overrides = config.theme ?? {};
	for (const key of Object.keys(defaultTheme) as (keyof Theme)[]) {
		const v = overrides[key];
		if (key in overrides && isValidColor(v)) out[key] = v;
	}
	return out;
}

// The known theme keys whose overrides are present but invalid, in defaultTheme
// order. Used to report ignored settings to the user.
export function themeErrors(config: { theme?: Partial<Theme> }): string[] {
	const overrides = config.theme ?? {};
	return (Object.keys(defaultTheme) as (keyof Theme)[])
		.filter((key) => key in overrides && !isValidColor(overrides[key]))
		.map(String);
}

export function createScreen(): Screen {
	return new Screen();
}
