import { MlKem768 } from 'leviathan-crypto/kyber';
import type { KeyPair } from './types.js';

export function generateKeypair(): KeyPair {
	const kem = new MlKem768();
	const { encapsulationKey: ek, decapsulationKey: dk } = kem.keygen();
	kem.dispose();
	return { ek, dk };
}
