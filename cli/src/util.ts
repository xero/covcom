import { existsSync } from 'fs';
import { extname, basename, dirname, join } from 'path';

export function b64enc(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64');
}

export function b64dec(s: string): Uint8Array {
	return new Uint8Array(Buffer.from(s, 'base64'));
}

// ws:// for localhost, wss:// for everything else
export function wsUrl(server: string): string {
	const host  = server.split(':')[0];
	const local = host === 'localhost' || host.startsWith('127.');
	return `${local ? 'ws' : 'wss'}://${server}/ws`;
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function resolveUniqueFilename(p: string): string {
	if (!existsSync(p)) return p;
	const ext  = extname(p);
	const base = basename(p, ext);
	const dir  = dirname(p);
	let i = 1;
	while (existsSync(join(dir, `${base}_${i}${ext}`))) i++;
	return join(dir, `${base}_${i}${ext}`);
}
