// @ts-check
import { fileURLToPath } from 'node:url';
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
	// ignores
	{
		ignores: [
			'**/node_modules/**',
			'**/dist/**',
			'**/build/**',
			'**/*.js',
			'**/*.html',
			'**/playwright.config.ts',
			'eslint.config.ts',
			'cli/src/tui/banner.ts',
			'cli/src/version.ts',
		],
	},

	// base rule sets
	eslint.configs.recommended,
	...tseslint.configs.strict,
	...tseslint.configs.stylistic,

	// all typescript files
	{
		files: ['**/*.ts'],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				// projectService auto-discovers each file's nearest tsconfig.json.
				// The web build-glue file lives in tsconfig.tools.json (not an
				// auto-discovered name), so allow it onto the inferred default
				// project rather than excluding it from lint.
				projectService: {
					allowDefaultProject: ['web/vite.config.ts'],
				},
				tsconfigRootDir: fileURLToPath(new URL('.', import.meta.url)),
			},
		},
		rules: {
			// formatting
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

			// safety
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

	// web client: no raw HTML-string DOM sinks
	// The web client builds DOM via el()/createElement + textContent so a
	// user-controlled value can never become markup. The one legitimate exception
	// (static SVG icons) goes through setHtml(el, SafeHtml) in web/src/safehtml.ts,
	// which is the sole sanctioned sink and carries its own disable comment.
	{
		files: ['web/src/**/*.ts'],
		rules: {
			'no-restricted-properties': ['error',
				{ property: 'innerHTML',          message: 'No raw HTML. Use setHtml(el, SafeHtml) from safehtml.ts.' },
				{ property: 'outerHTML',          message: 'No raw HTML. Use setHtml(el, SafeHtml) from safehtml.ts.' },
				{ property: 'insertAdjacentHTML', message: 'No raw HTML. Build DOM with el()/createElement.' },
				{ object: 'document', property: 'write',   message: 'document.write is forbidden.' },
				{ object: 'document', property: 'writeln', message: 'document.write is forbidden.' },
			],
		},
	},

	// test files
	{
		files: ['**/test/**/*.ts'],
		rules: {
			// Non-null assertions are acceptable in tests, shapes are known
			'@typescript-eslint/no-non-null-assertion': 'off',
		},
	},
]);
