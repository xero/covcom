export interface KeyPair {
	ek: Uint8Array // encapsulation key, 1184 bytes (MlKem768)
	dk: Uint8Array // decapsulation key, 2400 bytes (MlKem768)
}

export interface InvitePayload {
	version:    number    // populated by parseArmoredInvite; ignored by serializeInvite
	roomId:     string
	roomSecret: string    // base64, decodes to 16 raw bytes
	dns?:       string
}

// `message` is a chat line. Files stream as `file-begin` (carries the SealStream
// preamble + filename/size/mime) followed by N `file-chunk` frames. The optional
// fields are populated per type; see lib/src/filetransfer.ts and the clients.
export interface MessageEnvelope {
	type:       'message' | 'file-begin' | 'file-chunk'
	sender:     string
	counter:    number
	epoch:      number      // sender's epoch at seal time; starts 0
	ts:         number
	pn?:        number      // previous chain length; present only on first message of a new epoch
	filename?:  string      // file-begin
	size?:      number       // file-begin (total plaintext bytes)
	mime?:      string       // file-begin
	fileId?:    string       // file-begin + file-chunk: groups a transfer's frames
	chunkSize?: number       // file-begin: plaintext chunk size used by the sender
	preamble?:  string       // file-begin: base64 SealStream preamble
	seq?:       number       // file-chunk: 0-based chunk index
	final?:     boolean      // file-chunk: last chunk of the transfer
}
