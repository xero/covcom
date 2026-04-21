// @ts-check
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
	// ── Ignores ────────────────────────────────────────────────────────────────
	{
		ignores: [
			'**/node_modules/**',
			'**/dist/**',
			'**/build/**',
			'**/*.js',          // bundled outputs (leviathan.bundle.js etc.)
			'**/*.html',        // templates
			'**/playwright.config.ts',
			'eslint.config.ts',
		],
	},

	// ── Base rule sets ─────────────────────────────────────────────────────────
	eslint.configs.recommended,
	...tseslint.configs.strict,
	...tseslint.configs.stylistic,

	// ── All TypeScript files ───────────────────────────────────────────────────
	{
		files: ['**/*.ts'],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				// projectService auto-discovers each file's nearest tsconfig.json
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// ── Formatting ───────────────────────────────────────────────────────
			indent:                ['error', 'tab'],
			'no-tabs':             'off',
			quotes:                ['error', 'single'],
			semi:                  ['error', 'always'],
			'linebreak-style':     ['error', 'unix'],
			'no-trailing-spaces':  'error',
			'spaced-comment':      ['error', 'always'],
			'keyword-spacing':     ['error', { before: true, after: true }],
			'space-before-blocks': 'error',
			'space-infix-ops':     'error',
			'comma-spacing':       ['error', { before: false, after: true }],
			'key-spacing':         ['error', { beforeColon: false, afterColon: true }],
			'brace-style':         ['error', '1tbs', { allowSingleLine: false }],

			// ── Safety ───────────────────────────────────────────────────────────
			'no-eval':   'error',
			'no-var':    'error',
			eqeqeq:      ['error', 'always', { null: 'ignore' }],

			// Allow _ prefix for intentionally unused params/vars
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],
		},
	},

	// ── Test files ─────────────────────────────────────────────────────────────
	{
		files: ['**/test/**/*.ts'],
		rules: {
			// Non-null assertions are acceptable in tests — shapes are known
			'@typescript-eslint/no-non-null-assertion': 'off',
		},
	},
]);
