import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { b64dec, b64enc, formatBytes, resolveUniqueFilename, wsUrl } from '../src/util.ts';

describe('b64enc / b64dec', () => {
	test('round-trips arbitrary bytes', () => {
		const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 127, 128]);
		const round = b64dec(b64enc(bytes));
		expect(Array.from(round)).toEqual(Array.from(bytes));
	});

	test('empty input', () => {
		expect(b64enc(new Uint8Array())).toBe('');
		expect(b64dec('').length).toBe(0);
	});

	test('encodes to standard base64', () => {
		expect(b64enc(new Uint8Array([102, 111, 111]))).toBe('Zm9v'); // "foo"
	});
});

describe('wsUrl', () => {
	test('localhost uses ws://', () => {
		expect(wsUrl('localhost:3000')).toBe('ws://localhost:3000/ws');
	});

	test('127.x loopback uses ws://', () => {
		expect(wsUrl('127.0.0.1:3000')).toBe('ws://127.0.0.1:3000/ws');
	});

	test('public host uses wss://', () => {
		expect(wsUrl('example.com')).toBe('wss://example.com/ws');
		expect(wsUrl('chat.example.com:8443')).toBe('wss://chat.example.com:8443/ws');
	});
});

describe('formatBytes', () => {
	test('bytes under 1 KB', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(1023)).toBe('1023 B');
	});

	test('kilobytes', () => {
		expect(formatBytes(1024)).toBe('1.0 KB');
		expect(formatBytes(1536)).toBe('1.5 KB');
	});

	test('megabytes', () => {
		expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
		expect(formatBytes(Math.round(2.5 * 1024 * 1024))).toBe('2.5 MB');
	});
});

describe('resolveUniqueFilename', () => {
	const dir = mkdtempSync(join(tmpdir(), 'covcom-util-'));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test('returns path unchanged when it does not exist', () => {
		const p = join(dir, 'fresh.txt');
		expect(resolveUniqueFilename(p)).toBe(p);
	});

	test('suffixes _1, _2 on collision, preserving extension', () => {
		const p = join(dir, 'doc.txt');
		writeFileSync(p, 'x');
		expect(resolveUniqueFilename(p)).toBe(join(dir, 'doc_1.txt'));
		writeFileSync(join(dir, 'doc_1.txt'), 'x');
		expect(resolveUniqueFilename(p)).toBe(join(dir, 'doc_2.txt'));
	});
});
