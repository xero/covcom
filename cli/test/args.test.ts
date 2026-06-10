import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../src/args.ts';

describe('parseArgs', () => {
	test('no args yields all-false booleans and no values', () => {
		expect(parseArgs([])).toEqual({ help: false, version: false, clean: false, anon: false });
	});

	describe('long forms', () => {
		test('boolean long flags', () => {
			expect(parseArgs(['--version', '--clean', '--anon'])).toEqual({ help: false, version: true, clean: true, anon: true });
		});

		test('value long flag, space form', () => {
			expect(parseArgs(['--config', '/tmp/c.json'])).toMatchObject({ config: '/tmp/c.json' });
		});

		test('value long flag, equals form', () => {
			expect(parseArgs(['--config=/tmp/c.json', '--join=/tmp/i.room'])).toMatchObject({
				config: '/tmp/c.json',
				join: '/tmp/i.room',
			});
		});

		test('--flag= with empty value leaves it unset', () => {
			expect(parseArgs(['--config='])).toEqual({ help: false, version: false, clean: false, anon: false });
		});

		test('dangling value (next token is a flag) leaves it unset', () => {
			expect(parseArgs(['--join', '--clean'])).toEqual({ help: false, version: false, clean: true, anon: false });
		});

		test('unknown long flags are ignored', () => {
			expect(parseArgs(['--nope', '--clean'])).toEqual({ help: false, version: false, clean: true, anon: false });
		});
	});

	describe('short forms', () => {
		test('single short booleans', () => {
			expect(parseArgs(['-v', '-x', '-a'])).toEqual({ help: false, version: true, clean: true, anon: true });
		});

		test('value short, space form', () => {
			expect(parseArgs(['-c', '/tmp/c.json'])).toMatchObject({ config: '/tmp/c.json' });
		});

		test('value short, glued form', () => {
			expect(parseArgs(['-c/tmp/c.json'])).toMatchObject({ config: '/tmp/c.json' });
		});

		test('value short, equals form', () => {
			expect(parseArgs(['-c=/tmp/c.json'])).toMatchObject({ config: '/tmp/c.json' });
		});

		test('-c= with empty value leaves it unset', () => {
			expect(parseArgs(['-c='])).toEqual({ help: false, version: false, clean: false, anon: false });
		});

		test('dangling short value leaves it unset', () => {
			expect(parseArgs(['-j', '-x'])).toEqual({ help: false, version: false, clean: true, anon: false });
		});
	});

	describe('help', () => {
		test('short and long help flag', () => {
			expect(parseArgs(['-h'])).toMatchObject({ help: true });
			expect(parseArgs(['--help'])).toMatchObject({ help: true });
		});

		test('help bundles with other short booleans', () => {
			expect(parseArgs(['-hv'])).toEqual({ help: true, version: true, clean: false, anon: false });
		});
	});

	describe('bundling', () => {
		test('bundled booleans', () => {
			expect(parseArgs(['-xa'])).toEqual({ help: false, version: false, clean: true, anon: true });
			expect(parseArgs(['-vxa'])).toEqual({ help: false, version: true, clean: true, anon: true });
		});

		test('value short ends a bundle, value in next token', () => {
			expect(parseArgs(['-xac', '/tmp/c.json'])).toMatchObject({ clean: true, anon: true, config: '/tmp/c.json' });
		});

		test('value short ends a bundle, value glued', () => {
			expect(parseArgs(['-xac/tmp/c.json'])).toMatchObject({ clean: true, anon: true, config: '/tmp/c.json' });
		});

		test('value short ends a bundle, equals form', () => {
			expect(parseArgs(['-ac=/tmp/c.json'])).toMatchObject({ anon: true, config: '/tmp/c.json' });
		});

		test('an unknown short ends the cluster, earlier flags still set', () => {
			expect(parseArgs(['-xz'])).toEqual({ help: false, version: false, clean: true, anon: false });
		});
	});

	describe('mixed and order-independence', () => {
		test('long and short, values and booleans together', () => {
			expect(parseArgs(['--anon', '-c', '/tmp/c.json', '-j=/tmp/i.room', '-v'])).toEqual({
				help: false,
				version: true,
				clean: false,
				anon: true,
				config: '/tmp/c.json',
				join: '/tmp/i.room',
			});
		});

		test('a later occurrence overrides an earlier value', () => {
			expect(parseArgs(['-c', '/tmp/first.json', '--config', '/tmp/second.json'])).toMatchObject({
				config: '/tmp/second.json',
			});
		});
	});
});
