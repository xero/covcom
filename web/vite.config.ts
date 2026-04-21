import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig(({ mode }) => {
	const singleFile = mode === 'container'
	return {
		root: '.',
		plugins: singleFile ? [viteSingleFile()] : [],
		build: {
			outDir: 'dist',
			target: 'es2022',
		},
		optimizeDeps: {
			exclude: ['leviathan-crypto'],
		},
	}
})
