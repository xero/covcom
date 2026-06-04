import { init } from 'leviathan-crypto';
import { mlkemWasm } from 'leviathan-crypto/mlkem/embedded';
import { sha3Wasm } from 'leviathan-crypto/sha3/embedded';
import { chacha20Wasm } from 'leviathan-crypto/chacha20/embedded';
import { sha2Wasm } from 'leviathan-crypto/sha2/embedded';
import { ed25519Wasm } from 'leviathan-crypto/ed25519/embedded';
import { blake3Wasm } from 'leviathan-crypto/blake3/embedded';

let initialized = false;

export async function initCrypto(): Promise<void> {
	if (initialized) return;
	await init({
		mlkem: mlkemWasm,
		sha3: sha3Wasm,
		chacha20: chacha20Wasm,
		sha2: sha2Wasm,
		ed25519: ed25519Wasm,
		blake3: blake3Wasm,
	});
	initialized = true;
}
