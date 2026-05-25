// Generates web/public/covcom-pool-worker.js: the same-origin pool worker the
// web client spawns for file transfer.
//
// leviathan-crypto's SealStreamPool defaults to a blob: worker, which WebKit
// refuses under a strict CSP (see ../leviathan-crypto/docs/csp.md). The fix is a
// same-origin worker served from our own origin under `worker-src 'self'`. The
// shipped worker is ESM with relative imports, so it can't be served raw; we
// bundle it to a self-contained classic IIFE — the same approach cli/build.ts
// uses for the compiled binary. Vite copies public/ verbatim (vite-plugin-
// singlefile never inlines it) and serves it at the site root in dev and prod,
// so XChaCha20CipherWeb can spawn it same-origin with one code path.

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

// leviathan-crypto is a dependency of @covcom/lib, not of web directly, so resolve
// it the way the lib does — from the lib package dir. pool-worker.js sits next to
// the chacha20 entry inside the package dist.
const libDir = dirname(Bun.fileURLToPath(import.meta.resolve('@covcom/lib')))
const entry  = join(dirname(Bun.resolveSync('leviathan-crypto/chacha20', libDir)), 'pool-worker.js')
const out    = new URL('./public/covcom-pool-worker.js', import.meta.url)

const build = await Bun.build({
	entrypoints: [entry],
	target: 'browser',
	format: 'iife',
	minify: true,
})
if (!build.success) {
	process.stderr.write('pool worker build failed:\n')
	for (const msg of build.logs) process.stderr.write(`  ${msg.message}\n`)
	process.exit(1)
}

mkdirSync(dirname(Bun.fileURLToPath(out)), { recursive: true })
await Bun.write(out, await build.outputs[0].text())
process.stdout.write(`  → ${Bun.fileURLToPath(out)}\n`)
