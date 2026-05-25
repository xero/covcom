import { initCrypto } from '@covcom/lib';
import { CovcomSession } from './session.js';
import { wireBridge } from './bridge.js';
import { mountShell } from './views/shell.js';
import { dispatch } from './store.js';

async function boot(): Promise<void> {
	try {
		await initCrypto();
		const app = document.getElementById('app');
		if (!app) throw new Error('missing #app element');

		const session = new CovcomSession();
		const unwire  = wireBridge(session);
		mountShell(app, session);

		window.addEventListener('beforeunload', () => {
			session.dispose();
			unwire();
			dispatch({ type: 'RESET' });
		});
	} catch (e) {
		document.body.textContent = `Crypto init failed: ${e}`;
	}
}

void boot();
