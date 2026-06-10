export interface Key {
	name:  string
	ch?:   string
	ctrl:  boolean
	shift: boolean
	meta:  boolean
}

export interface MouseEvent {
	type:   'click' | 'release' | 'scroll'
	button: number
	x:      number
	y:      number
}

export type InputEvent =
	| { kind: 'key';   key:   Key }
	| { kind: 'mouse'; mouse: MouseEvent }
	| { kind: 'paste'; text:  string }

function k(name: string, opts: { ctrl?: boolean; shift?: boolean; meta?: boolean; ch?: string } = {}): InputEvent {
	return { kind: 'key', key: { name, ch: opts.ch, ctrl: opts.ctrl ?? false, shift: opts.shift ?? false, meta: opts.meta ?? false } };
}

export function parseInput(buf: Buffer): InputEvent {
	const s = buf.toString('binary');

	// SGR mouse: \x1b[<btn;x;yM or \x1b[<btn;x;ym
	if (s.startsWith('\x1b[<')) {
		const m = /\[<(\d+);(\d+);(\d+)([Mm])/.exec(s);
		if (m) {
			const btn     = parseInt(m[1]);
			const x       = parseInt(m[2]);
			const y       = parseInt(m[3]);
			const release = m[4] === 'm';
			const type: MouseEvent['type'] = btn >= 64 ? 'scroll' : release ? 'release' : 'click';
			return { kind: 'mouse', mouse: { type, button: btn, x, y } };
		}
	}

	// bracketed paste
	if (s.startsWith('\x1b[200~')) {
		const end  = s.indexOf('\x1b[201~');
		const raw  = end >= 0 ? s.slice(6, end) : s.slice(6);
		return { kind: 'paste', text: Buffer.from(raw, 'binary').toString('utf8') };
	}

	// escape sequences
	if (s === '\x1b[A' || s === '\x1bOA')  return k('up');
	if (s === '\x1b[B' || s === '\x1bOB')  return k('down');
	if (s === '\x1b[C' || s === '\x1bOC')  return k('right');
	if (s === '\x1b[D' || s === '\x1bOD')  return k('left');
	if (s === '\x1b[Z')                    return k('tab', { shift: true });
	if (s === '\x1b[H' || s === '\x1b[1~') return k('home');
	if (s === '\x1b[F' || s === '\x1b[4~') return k('end');
	if (s === '\x1b[5~')                   return k('pageup');
	if (s === '\x1b[6~')                   return k('pagedown');
	if (s === '\x1b[3~')                   return k('delete');
	if (s === '\x1b[2~')                   return k('insert');

	// standalone escape (no following char)
	if (s === '\x1b')                      return k('escape');

	// control characters
	if (s === '\r' || s === '\r\n')        return k('enter');
	if (s === '\t')                        return k('tab');
	if (s === '\x7f')                      return k('backspace');
	if (s === '\x08')                      return k('backspace', { ctrl: true });

	const byte = buf[0];

	// ctrl+letter: bytes 0x01-0x1a
	// (skip 0x08=bs, 0x09=tab, 0x0a=lf, 0x0d=cr already handled)
	if (byte >= 0x01 && byte <= 0x1a) {
		const ch = String.fromCharCode(byte + 0x60);
		return k(ch, { ctrl: true, ch });
	}

	// printable UTF-8. Single char is a keypress, multi-char is unbracketed paste.
	const text = buf.toString('utf8');
	if (text.length > 0 && (text.codePointAt(0) ?? 0) >= 0x20) {
		if (text.length > 1) return { kind: 'paste', text };
		return k(text, { ch: text });
	}

	return k('unknown');
}
