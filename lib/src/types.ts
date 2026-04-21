export interface KeyPair {
	ek: Uint8Array // encapsulation key — 1184 bytes (MlKem768)
	dk: Uint8Array // decapsulation key — 2400 bytes (MlKem768)
}

export interface InvitePayload {
	version:    number    // populated by parseArmoredInvite; ignored by serializeInvite
	roomId:     string
	roomSecret: string    // base64, decodes to 16 raw bytes
	dns?:       string
}

export interface MessageEnvelope {
	type:      'message' | 'file'
	sender:    string
	counter:   number
	epoch:     number      // sender's epoch at seal time; starts 0
	ts:        number
	pn?:       number      // previous chain length; present only on first message of a new epoch
	filename?: string
	size?:     number
	mime?:     string
}
