import { test, expect, describe } from 'bun:test';
import { Glob } from 'bun';
import { setHtml, trustedHtml } from '../src/safehtml.js';
import { ICON_COG } from '../src/icons.js';

describe('setHtml', () => {
	test('injects trusted markup into the DOM', () => {
		const div = document.createElement('div');
		setHtml(div, trustedHtml('<b>hi</b>'));
		expect(div.querySelector('b')?.textContent).toBe('hi');
	});

	test('renders an icon SafeHtml constant as an <svg>', () => {
		const div = document.createElement('div');
		setHtml(div, ICON_COG);
		expect(div.querySelector('svg')).not.toBeNull();
	});
});

// The CI-enforced backstop: CI runs `bun test` but neither eslint nor tsc, so
// this guards the "no HTML-string path" convention directly. It fails if any
// web/src file reaches a raw HTML sink; the only sanctioned one lives in
// safehtml.ts. The patterns are dot-anchored so prose like rich.ts's "no
// innerHTML anywhere" comment is not a false positive.
describe('web/src has no raw HTML-string sinks outside safehtml.ts', () => {
	test('no .innerHTML / .outerHTML / .insertAdjacentHTML / document.write', async () => {
		const sinkRe    = /\.(innerHTML|outerHTML|insertAdjacentHTML)\b|\bdocument\.write/;
		const glob      = new Glob('src/**/*.ts');
		const offenders: string[] = [];
		for (const path of glob.scanSync('.')) {
			if (path.endsWith('safehtml.ts')) continue;
			if (sinkRe.test(await Bun.file(path).text())) offenders.push(path);
		}
		expect(offenders).toEqual([]);
	});
});
