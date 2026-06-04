import { defineConfig } from '@playwright/test';

// Two-party e2e for the web client across all three engines (chromium, firefox,
// webkit), mirroring leviathan-crypto. The client is end-to-end encrypted with a
// dumb relay, so a meaningful test needs the Bun WS broker plus the web app, then
// two browser contexts (alice creates, bob joins).
//
// The app is served from its BUILT artifact, not the Vite dev server: dev-mode
// Vite injects no CSP, so it cannot catch CSP regressions. The built index.html
// is a single inlined file carrying the strict `<meta>` CSP (`default-src 'none'`,
// no worker-src); file transfer runs on the main thread via SealStream/OpenStream,
// so the file-transfer test exercises the real Safari/WebKit path with no worker.
// `bunx serve` hosts dist/ statically
// (no CSP header of its own, so the meta tag governs). The broker answers
// `GET /health_check` (200) as its readiness probe; the production CSP's
// connect-src allows ws://localhost:*, so the page (4173) reaches the broker
// (3000) over plaintext ws. Servers start via workspace-root shorthands
// (AGENTS.md forbids raw package-level commands).
export default defineConfig({
	testDir:   'web/test/e2e',
	// e2e files use a `.e2e.ts` suffix (not `.spec`/`.test`) so Bun's own test
	// runner never tries to execute them as unit tests.
	testMatch: '**/*.e2e.ts',
	outputDir: 'web/test/e2e/results',
	fullyParallel: false,
	timeout:   120_000,
	expect:    { timeout: 15_000 },
	use: {
		baseURL: 'http://localhost:4173',
		trace:   'retain-on-failure',
	},
	projects: [
		{ name: 'chromium', use: { browserName: 'chromium' } },
		{ name: 'firefox',  use: { browserName: 'firefox'  } },
		{ name: 'webkit',   use: { browserName: 'webkit'   } },
	],
	webServer: [
		{
			command: 'bun dev:server',
			url: 'http://localhost:3000/health_check',
			reuseExistingServer: true,
			timeout: 30_000,
			env: { PORT: '3000', MAX_ROOM_SIZE: '20' },
		},
		{
			command: 'bun run build:web && bunx serve web/dist -l 4173',
			url: 'http://localhost:4173',
			reuseExistingServer: true,
			timeout: 120_000,
		},
	],
});
