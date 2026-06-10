// Drives the real CLI binary over a pseudo-terminal so its TUI runs exactly as a
// user would see it: Bun.spawn's `terminal` option attaches a PTY, so the CLI's
// process.stdin.setRawMode and process.stdout.columns/rows work (a plain pipe
// would make setRawMode throw). Keystrokes go in via terminal.write; the data
// callback accumulates every byte the CLI emits. We never clear the buffer, so
// "did this text ever render" checks survive the CLI's full-frame redraws.

// eslint-disable-next-line no-control-regex -- stripping the CLI's ANSI/CSI control sequences is the point
const ANSI = /[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export interface CliOpts {
	cols?: number;
	rows?: number;
	env?:  Record<string, string>;
	cwd?:  string;
}

export interface CliSession {
	// raw byte length of the accumulated PTY output, for marking a point in time
	rawLen(): number;
	// the whole PTY output with ANSI control sequences stripped
	screen(): string;
	// the PTY output since `rawIdx` (a prior rawLen()), ANSI-stripped
	screenFrom(rawIdx: number): string;
	// feed keystrokes, then pause briefly so the event-driven TUI can repaint
	write(keys: string): Promise<void>;
	// poll until `needle` appears in the screen (optionally only after `fromRaw`)
	waitFor(needle: string | RegExp, timeoutMs?: number, fromRaw?: number): Promise<void>;
	close(): void;
}

export function startCliSession(bin: string, args: string[] = [], opts: CliOpts = {}): CliSession {
	let buf = '';
	const proc = Bun.spawn([bin, ...args], {
		terminal: {
			cols: opts.cols ?? 120,
			rows: opts.rows ?? 40,
			data(_t, bytes) {
				buf += new TextDecoder().decode(bytes);
			},
		},
		cwd: opts.cwd,
		env: opts.env ? { ...process.env, ...opts.env } : { ...process.env },
	});
	const term = proc.terminal;
	if (!term) throw new Error('Bun.spawn did not attach a terminal');

	const clean = (s: string): string => s.replace(ANSI, '');
	const hit   = (hay: string, needle: string | RegExp): boolean =>
		typeof needle === 'string' ? hay.includes(needle) : needle.test(hay);

	return {
		rawLen() {
			return buf.length;
		},
		screen() {
			return clean(buf);
		},
		screenFrom(rawIdx) {
			return clean(buf.slice(rawIdx));
		},

		async write(keys) {
			term.write(keys);
			await Bun.sleep(60);
		},

		async waitFor(needle, timeoutMs = 20_000, fromRaw = 0) {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				if (hit(clean(buf.slice(fromRaw)), needle)) return;
				if (Date.now() > deadline)
					throw new Error(`CLI screen never matched ${needle} within ${timeoutMs}ms`);
				await Bun.sleep(100);
			}
		},

		close() {
			try {
				term.close();
			} catch { /* already rip */ }
			proc.kill();
		},
	};
}
