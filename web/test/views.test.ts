import { beforeEach, describe, expect, test } from 'bun:test';
import { armorInvite, INVITE_VERSION, serializeInvite } from '@covcom/lib';
import type { InvitePayload } from '@covcom/lib';
import { mountLanding } from '../src/views/landing.ts';
import type { CovcomSession } from '../src/session.ts';

// Light smoke coverage of the landing/create/join DOM and its wiring to the
// session. Real interaction coverage lives in the playwright e2e; here we only
// confirm the forms render and clicks call the right session method.
// parseArmoredInvite (used by the join form) is pure base64; no crypto init
// required.

interface FakeCalls {
	create: { server: string; username: string; adminToken?: string }[];
	join:   { invite: InvitePayload; username: string }[];
}

function fakeSession(): { session: CovcomSession; calls: FakeCalls } {
	const calls: FakeCalls = { create: [], join: [] };
	const session = {
		create(opts: { server: string; username: string; adminToken?: string }) {
			calls.create.push(opts); return Promise.resolve();
		},
		join(invite: InvitePayload, username: string) {
			calls.join.push({ invite, username }); return Promise.resolve();
		},
	} as unknown as CovcomSession;
	return { session, calls };
}

function armoredInvite(): string {
	return armorInvite(serializeInvite({
		version: INVITE_VERSION,
		roomId: 'r'.repeat(32),
		roomSecret: btoa(String.fromCharCode(...new Uint8Array(16).fill(7))),
		dns: 'localhost:1337',
	}));
}

function clickButton(label: string): void {
	[...app.querySelectorAll('button')].find(b => b.textContent === label)!.click();
}

let app: HTMLElement;

beforeEach(() => {
	document.body.innerHTML = '';
	app = document.createElement('main');
	document.body.appendChild(app);
});

describe('landing form', () => {
	test('renders username and the action buttons, but no server field', () => {
		const { session } = fakeSession();
		mountLanding(app, session, { name: 'landing' });
		expect(app.querySelector('#username')).not.toBeNull();
		expect(app.querySelector('#server')).toBeNull();
		const labels = [...app.querySelectorAll('button')].map(b => b.textContent);
		expect(labels).toContain('Create Room');
		expect(labels).toContain('Join Room');
	});

	test('surfaces the prefilled username', () => {
		const { session } = fakeSession();
		mountLanding(app, session, { name: 'landing', prefill: { username: 'carol' } });
		expect((app.querySelector('#username') as HTMLInputElement).value).toBe('carol');
	});
});

describe('create form', () => {
	function gotoCreate(username = 'alice'): void {
		const { session } = fakeSession();
		mountLanding(app, session, { name: 'landing' });
		(app.querySelector('#username') as HTMLInputElement).value = username;
		clickButton('Create Room');
	}

	test('Create Room swaps in the server field, defaulting to the page host', () => {
		gotoCreate();
		const server = app.querySelector('#server') as HTMLInputElement;
		expect(server).not.toBeNull();
		expect(server.value).toBe(location.host);
		expect((app.querySelector('#username') as HTMLInputElement).value).toBe('alice');
	});

	test('Create Room calls session.create with the typed values', () => {
		const { session, calls } = fakeSession();
		mountLanding(app, session, { name: 'landing' });
		(app.querySelector('#username') as HTMLInputElement).value = 'alice';
		clickButton('Create Room');
		(app.querySelector('#server') as HTMLInputElement).value = 'localhost:1337';
		clickButton('Create Room');
		expect(calls.create).toHaveLength(1);
		expect(calls.create[0]).toMatchObject({ server: 'localhost:1337', username: 'alice' });
	});

	test('Create Room with an empty server shows an error and does not connect', () => {
		const { session, calls } = fakeSession();
		mountLanding(app, session, { name: 'landing' });
		(app.querySelector('#username') as HTMLInputElement).value = 'alice';
		clickButton('Create Room');
		(app.querySelector('#server') as HTMLInputElement).value = '';
		clickButton('Create Room');
		expect(calls.create).toHaveLength(0);
		const err = app.querySelector('.error') as HTMLElement;
		expect(err.style.display).not.toBe('none');
	});

	test('a fatal error restores the create form with the entered server and the message', () => {
		const { session } = fakeSession();
		mountLanding(app, session, { name: 'landing' });
		(app.querySelector('#username') as HTMLInputElement).value = 'alice';
		clickButton('Create Room');
		(app.querySelector('#server') as HTMLInputElement).value = 'relay.example:9000';
		clickButton('Create Room');  // sets pendingForm, calls session.create
		// session emits fatal -> store routes back to landing with an error
		mountLanding(app, session, { name: 'landing', error: 'Room is full.' });
		expect((app.querySelector('#server') as HTMLInputElement).value).toBe('relay.example:9000');
		expect((app.querySelector('.error') as HTMLElement).textContent).toBe('Room is full.');
	});

	test('the fatal error survives the transient RESET remount that precedes GOTO_LANDING', () => {
		const { session } = fakeSession();
		mountLanding(app, session, { name: 'landing' });
		(app.querySelector('#username') as HTMLInputElement).value = 'alice';
		clickButton('Create Room');
		(app.querySelector('#server') as HTMLInputElement).value = 'relay.example:9000';
		clickButton('Create Room');  // sets pendingForm, calls session.create
		// bridge's fatal handler dispatches RESET (error-less landing) then
		// GOTO_LANDING (carrying the error); the transient RESET remount must not
		// drop pendingForm, or the error never reaches the restored sub-screen.
		mountLanding(app, session, { name: 'landing' });
		mountLanding(app, session, { name: 'landing', error: 'Could not reach the server.' });
		expect((app.querySelector('#server') as HTMLInputElement).value).toBe('relay.example:9000');
		expect((app.querySelector('.error') as HTMLElement).textContent).toBe('Could not reach the server.');
	});
});

describe('join form', () => {
	function gotoJoin(): { calls: FakeCalls } {
		const { session, calls } = fakeSession();
		mountLanding(app, session, { name: 'landing' });
		(app.querySelector('#username') as HTMLInputElement).value = 'bob';
		clickButton('Join Room');
		return { calls };
	}

	test('Join Room swaps in the paste view with the username carried over', () => {
		gotoJoin();
		expect(app.querySelector('.view-join')).not.toBeNull();
		expect(app.querySelector('textarea')).not.toBeNull();
		expect((app.querySelector('#username') as HTMLInputElement).value).toBe('bob');
	});

	test('a valid invite connects directly, no parse step', () => {
		const { calls } = gotoJoin();
		(app.querySelector('textarea') as HTMLTextAreaElement).value = armoredInvite();
		clickButton('Join Room');
		expect(calls.join).toHaveLength(1);
		expect(calls.join[0].invite.roomId).toBe('r'.repeat(32));
		expect(calls.join[0].username).toBe('bob');
	});

	test('garbage shows a parse error and does not connect', () => {
		const { calls } = gotoJoin();
		(app.querySelector('textarea') as HTMLTextAreaElement).value = 'not an invite';
		clickButton('Join Room');
		expect(calls.join).toHaveLength(0);
		const err = app.querySelector('.error') as HTMLElement;
		expect(err.style.display).not.toBe('none');
		expect(err.textContent).toContain('Parse error');
	});

	test('a username collision restores the join form with the invite and message intact', () => {
		gotoJoin();
		const invite = armoredInvite();
		(app.querySelector('textarea') as HTMLTextAreaElement).value = invite;
		clickButton('Join Room');  // parses, sets pendingForm, calls session.join
		const { session } = fakeSession();
		// RESET remount then the error-bearing GOTO_LANDING (the username_taken path).
		mountLanding(app, session, { name: 'landing' });
		mountLanding(app, session, { name: 'landing', error: 'That username is taken in this room.' });
		expect(app.querySelector('.view-join')).not.toBeNull();
		// the connect handler trims before stashing, so the restore is the trimmed invite
		expect((app.querySelector('textarea') as HTMLTextAreaElement).value).toBe(invite.trim());
		expect((app.querySelector('.error') as HTMLElement).textContent).toBe('That username is taken in this room.');
	});
});
