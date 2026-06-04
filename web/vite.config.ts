import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { createHash } from 'node:crypto';

// Injects a strict Content-Security-Policy <meta> into the built index.html.
// Build-only (apply: 'build') so the Vite dev server, which injects its own
// inline HMR scripts, is unaffected. Runs in generateBundle with enforce:'post'
// so it observes the HTML *after* viteSingleFile has inlined the bundle, letting
// it hash the inline script for a no-'unsafe-inline' script-src.
//
// The load-bearing facts:
//  - 'wasm-unsafe-eval' permits WebAssembly.{compile,instantiate} but not
//    eval/new Function. All crypto, messages and streamed file transfer alike,
//    runs as WASM on the main thread. No worker is spawned, so no worker-src is
//    needed and `default-src 'none'` blocks workers outright; the app is a true
//    single-file SPA. (File transfer formerly used a same-origin pool worker to
//    dodge WebKit's blob:-worker CSP refusal; SealStream/OpenStream replaced it.)
//  - connect-src: 'self' covers the same-origin container (wss://DOMAIN/ws via
//    Caddy); wss: covers a decoupled remote relay; ws://localhost|127.* covers
//    plaintext self-host. The client makes no http(s) fetch at runtime.
function csp(): Plugin {
	return {
		name: 'covcom-csp',
		apply: 'build',
		enforce: 'post',
		generateBundle(_opts, bundle) {
			for (const file of Object.values(bundle)) {
				if (file.type !== 'asset' || !file.fileName.endsWith('.html')) continue;
				const html = typeof file.source === 'string'
					? file.source
					: Buffer.from(file.source).toString('utf8');

				// Hash every inline <script> (no src attr); the single-file build has
				// no external scripts, so no 'self' is needed; strictest possible.
				const hashes: string[] = [];
				const re = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
				let m: RegExpExecArray | null;
				while ((m = re.exec(html)) !== null) {
					const digest = createHash('sha256').update(m[1], 'utf8').digest('base64');
					hashes.push(`'sha256-${digest}'`);
				}
				const scriptSrc = ['\'wasm-unsafe-eval\'', ...hashes].join(' ');

				const policy = [
					'default-src \'none\'',
					`script-src ${scriptSrc}`,
					'style-src \'unsafe-inline\'',
					'connect-src \'self\' wss: ws://localhost:* ws://127.0.0.1:*',
					'img-src \'self\' data: blob:',
					'font-src \'none\'',
					'base-uri \'none\'',
					'object-src \'none\'',
					'form-action \'none\'',
					'frame-ancestors \'none\'',
				].join('; ');

				const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}" />`;
				file.source = html.replace(/<head>/i, `<head>\n\t\t${meta}`);
			}
		},
	};
}

export default defineConfig({
	root: '.',
	plugins: [
		viteSingleFile(),
		csp(),
	],
	build: {
		outDir: 'dist',
		target: 'es2022',
	},
	optimizeDeps: {
		exclude: ['leviathan-crypto'],
	},
});
