import { initCrypto } from '@covcom/lib';
import { mount } from './state.js';

async function boot(): Promise<void> {
	try {
		await initCrypto();
		const app = document.getElementById('app');
		if (!app) throw new Error('missing #app element');
		mount(app);
	} catch (e) {
		document.body.textContent = `Crypto init failed: ${e}`;
	}
}

void boot();
