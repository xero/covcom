import { init as initLib }    from '@covcom/lib';
import { init as initDirect } from 'leviathan-crypto';
import { mlkemWasm }      from 'leviathan-crypto/mlkem/embedded';
import { sha3Wasm }       from 'leviathan-crypto/sha3/embedded';
import { chacha20Wasm }   from 'leviathan-crypto/chacha20/embedded';
import { sha2Wasm }       from 'leviathan-crypto/sha2/embedded';
import { ed25519Wasm }    from 'leviathan-crypto/ed25519/embedded';
import { blake3Wasm }     from 'leviathan-crypto/blake3/embedded';

function b64decode(s: string): Uint8Array<ArrayBuffer> {
	const src = Buffer.from(s, 'base64');
	const dst = new Uint8Array(src.length);
	dst.set(src);
	return dst;
}

async function decodeWasm(blob: string): Promise<WebAssembly.Module> {
	const decompressed = Bun.gunzipSync(b64decode(blob));
	return WebAssembly.compile(decompressed.buffer as ArrayBuffer);
}

let initialized = false;

export async function initCrypto(): Promise<void> {
	if (initialized) return;
	const [mlkem, sha3, chacha20, sha2, ed25519, blake3] = await Promise.all([
		decodeWasm(mlkemWasm as string),
		decodeWasm(sha3Wasm as string),
		decodeWasm(chacha20Wasm as string),
		decodeWasm(sha2Wasm as string),
		decodeWasm(ed25519Wasm as string),
		decodeWasm(blake3Wasm as string),
	]);
	const modules = { mlkem, sha3, chacha20, sha2, ed25519, blake3 };
	await Promise.all([initLib(modules), initDirect(modules)]);
	initialized = true;
}
