// Inbound client to server messages

export interface CreateMsg {
	type:        'create'
	adminToken?: string
}

export interface JoinMsg {
	type:       'join'
	roomId:     string
	roomSecret: string
}

export interface IdentifyMsg {
	type:      'identify'
	username:  string
	ek:        string   // base64 Seal encapsulation key (chain seed distribution)
	ratchetEk: string   // base64 RatchetKeypair ek (for KEM ratchet steps)
	claim:     string   // base64 Sign.sign envelope of the identity claim
}

export interface RelayMsg {
	type: 'relay'
	to: string
	payload: string
}

export interface BroadcastMsg {
	type: 'broadcast'
	payload: string
	meta: Record<string, unknown>
	sig:  string  // base64 detached Ed25519PreHash signature
}

// client sends one ratchet_step containing a per-recipient payload map.
// server fans out one ratchet_step_fwd to each named recipient.
export interface RatchetStepMsg {
	type:     'ratchet_step'
	// keyed by recipient username; each value is that peer's pairwise payload
	payloads: Record<string, { kemCt: string; encSeed: string; pn: number }>
	newEk:    string  // base64 sender's new ratchetEk after this step
	payload:  string  // base64 ciphertext of the message accompanying this step
	meta:     Record<string, unknown>  // MessageEnvelope (epoch, counter, etc.)
	sig:      string  // base64 detached signature over the accompanying message
	claim:    string  // base64 Sign.sign envelope of the ratchet-step claim
}

// announces a new ratchet ek after keypair rotation
export interface EkUpdateMsg {
	type:  'ek_update'
	ek:    string  // base64
	claim: string  // base64 Sign.sign envelope binding the new ek to the session pk
}

export interface RekeyMsg {
	type:      'rekey'
	ek:        string
	ratchetEk: string
	claim:     string   // fresh identity claim for the post-transition session
}

export type InboundMsg =
	| CreateMsg
	| JoinMsg
	| IdentifyMsg
	| RelayMsg
	| BroadcastMsg
	| RatchetStepMsg
	| EkUpdateMsg
	| RekeyMsg

// Outbound server to client messages

export interface RoomCreatedMsg {
	type:       'room_created'
	roomId:     string
	roomSecret: string
}

export interface JoinedMsg {
	type:    'joined'
	members: { username: string; ek: string; ratchetEk: string; claim: string }[]
}

export interface PeerJoinedMsg {
	type:      'peer_joined'
	username:  string
	ek:        string
	ratchetEk: string
	claim:     string
}

export interface PeerLeftMsg {
	type: 'peer_left'
	username: string
}

export interface RelayFwdMsg {
	type: 'relay'
	from: string
	payload: string
}

export interface BroadcastFwdMsg {
	type: 'broadcast'
	from: string
	payload: string
	meta: Record<string, unknown>
	sig:  string
}

export interface ErrorMsg {
	type: 'error'
	reason: 'room_full' | 'not_found' | 'forbidden' | 'username_taken'
}

// server delivers one of these per recipient from a ratchet_step
export interface RatchetStepFwdMsg {
	type:    'ratchet_step_fwd'
	from:    string
	kemCt:   string
	encSeed: string
	pn:      number
	newEk:   string  // sender's new ek
	payload: string  // ciphertext for this recipient to decrypt after applying the step
	meta:    Record<string, unknown>
	sig:     string  // detached signature over the accompanying message
	claim:   string  // ratchet-step claim envelope
}

export interface EkUpdateFwdMsg {
	type:  'ek_update_fwd'
	from:  string
	ek:    string
	claim: string
}

export interface RekeyedMsg {
	type: 'rekeyed'
}

export type OutboundMsg =
	| RoomCreatedMsg
	| JoinedMsg
	| PeerJoinedMsg
	| PeerLeftMsg
	| RelayFwdMsg
	| BroadcastFwdMsg
	| ErrorMsg
	| RatchetStepFwdMsg
	| EkUpdateFwdMsg
	| RekeyedMsg
