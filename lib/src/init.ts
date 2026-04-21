import { init } from 'leviathan-crypto';
import { kyberWasm } from 'leviathan-crypto/kyber/embedded';
import { sha3Wasm } from 'leviathan-crypto/sha3/embedded';
import { chacha20Wasm } from 'leviathan-crypto/chacha20/embedded';
import { sha2Wasm } from 'leviathan-crypto/sha2/embedded';

let initialized = false;

export async function initCrypto(): Promise<void> {
	if (initialized) return;
	await init({ kyber: kyberWasm, sha3: sha3Wasm, chacha20: chacha20Wasm, sha2: sha2Wasm });
	initialized = true;
}

// Exposed so SealStreamPool callers in web/ and cli/ can pass the WASM source
// without importing leviathan-crypto directly.
export { chacha20Wasm };
