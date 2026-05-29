import { defineConfig } from '@playwright/test';

// Two-party e2e for the web client. The web client is end-to-end encrypted with
// a dumb relay server, so a meaningful test needs both the Bun WS broker and the
// Vite dev server running, then two browser contexts (alice creates, bob joins).
//
// Both servers are started via the workspace-root shorthands (AGENTS.md forbids
// raw package-level commands). The broker answers `GET /health_check` (200), so
// that is its readiness probe; Vite's root URL is its own. Dev-mode Vite injects
// no CSP, and the client's connect-src allows ws://localhost:*, so the browser
// reaches the broker over plaintext ws.
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
		baseURL: 'http://localhost:5173',
		trace:   'retain-on-failure',
	},
	// chromium is the reliable WASM target to start with; firefox/webkit can be
	// added here once this is green (leviathan-crypto runs all three).
	projects: [
		{ name: 'chromium', use: { browserName: 'chromium' } },
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
			command: 'bun dev:web --port 5173 --strictPort',
			url: 'http://localhost:5173',
			reuseExistingServer: true,
			timeout: 60_000,
		},
	],
});
