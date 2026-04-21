import { init as initLib }    from '@covcom/lib';
import { init as initDirect } from 'leviathan-crypto';
import { kyberWasm }      from 'leviathan-crypto/kyber/embedded';
import { sha3Wasm }       from 'leviathan-crypto/sha3/embedded';
import { chacha20Wasm }   from 'leviathan-crypto/chacha20/embedded';
import { sha2Wasm }       from 'leviathan-crypto/sha2/embedded';

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
	const [kyber, sha3, chacha20, sha2] = await Promise.all([
		decodeWasm(kyberWasm as string),
		decodeWasm(sha3Wasm as string),
		decodeWasm(chacha20Wasm as string),
		decodeWasm(sha2Wasm as string),
	]);
	const modules = { kyber, sha3, chacha20, sha2 };
	await Promise.all([initLib(modules), initDirect(modules)]);
	initialized = true;
}
