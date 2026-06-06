import { defineConfig } from '@playwright/test';
export default defineConfig({
	reporter:  [['list'], ['./web/test/e2e/timing-reporter.ts']],
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
	webServer: [{
		command: 'bun dev:server',
		url: 'http://localhost:3000/health_check',
		reuseExistingServer: true,
		timeout: 30_000,
		env: { PORT: '3000', MAX_ROOM_SIZE: '20' },
	},{
		command: 'bun run build:web && bunx serve web/dist -l 4173',
		url: 'http://localhost:4173',
		reuseExistingServer: true,
		timeout: 120_000,
	}],
});
