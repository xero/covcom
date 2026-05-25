import { beforeEach, describe, expect, test } from 'bun:test';
import { armorInvite, INVITE_VERSION, serializeInvite } from '@covcom/lib';
import type { InvitePayload } from '@covcom/lib';
import { mountLanding } from '../src/views/landing.ts';
import type { CovcomSession } from '../src/session.ts';

// Light smoke coverage of the landing/join DOM and its wiring to the session.
// Real interaction coverage lives in the playwright e2e; here we only confirm
// the form renders and clicks call the right session method. parseArmoredInvite
// (used by the join form) is pure base64; no crypto init required.

interface FakeCalls {
	create: { server: string; username: string; adminToken?: string }[];
	join:   { invite: InvitePayload; username: string }[];
}

function fakeSession(): { session: CovcomSession; calls: FakeCalls } {
	const calls: FakeCalls = { create: [], join: [] };
	const session = {
		create(opts: { server: string; username: string; adminToken?: string }) { calls.create.push(opts); return Promise.resolve(); },
		join(invite: InvitePayload, username: string) { calls.join.push({ invite, username }); return Promise.resolve(); },
	} as unknown as CovcomSession;
	return { session, calls };
}

function armoredInvite(): string {
	return armorInvite(serializeInvite({
		version: INVITE_VERSION,
		roomId: 'r'.repeat(32),
		roomSecret: btoa(String.fromCharCode(...new Uint8Array(16).fill(7))),
		dns: 'localhost:3000',
	}));
}

let app: HTMLElement;

beforeEach(() => {
	document.body.innerHTML = '';
	app = document.createElement('main');
	document.body.appendChild(app);
});

describe('landing form', () => {
	test('renders server + username fields and the action buttons', () => {
		const { session } = fakeSession();
		mountLanding(app, session, { name: 'landing' });
		expect(app.querySelector('#server')).not.toBeNull();
		expect(app.querySelector('#username')).not.toBeNull();
		const labels = [...app.querySelectorAll('button')].map(b => b.textContent);
		expect(labels).toContain('Create Room');
		expect(labels).toContain('Join Room');
	});

	test('surfaces the prefilled username', () => {
		const { session } = fakeSession();
		mountLanding(app, session, { name: 'landing', prefill: { username: 'carol' } });
		expect((app.querySelector('#username') as HTMLInputElement).value).toBe('carol');
	});

	test('Create Room calls session.create with the typed values', () => {
		const { session, calls } = fakeSession();
		mountLanding(app, session, { name: 'landing' });
		(app.querySelector('#server') as HTMLInputElement).value = 'localhost:3000';
		(app.querySelector('#username') as HTMLInputElement).value = 'alice';
		const create = [...app.querySelectorAll('button')].find(b => b.textContent === 'Create Room')!;
		create.click();
		expect(calls.create).toHaveLength(1);
		expect(calls.create[0]).toMatchObject({ server: 'localhost:3000', username: 'alice' });
	});

	test('Create Room with empty fields shows an error and does not connect', () => {
		const { session, calls } = fakeSession();
		mountLanding(app, session, { name: 'landing' });
		const create = [...app.querySelectorAll('button')].find(b => b.textContent === 'Create Room')!;
		create.click();
		expect(calls.create).toHaveLength(0);
		const err = app.querySelector('.error') as HTMLElement;
		expect(err.style.display).not.toBe('none');
	});

	test('shows the prior error from the screen state', () => {
		const { session } = fakeSession();
		mountLanding(app, session, { name: 'landing', error: 'Room is full.' });
		expect((app.querySelector('.error') as HTMLElement).textContent).toBe('Room is full.');
	});
});

describe('join form', () => {
	function gotoJoin(): void {
		const { session } = fakeSession();
		mountLanding(app, session, { name: 'landing' });
		(app.querySelector('#username') as HTMLInputElement).value = 'bob';
		[...app.querySelectorAll('button')].find(b => b.textContent === 'Join Room')!.click();
	}

	test('Join Room swaps in the paste/parse view', () => {
		gotoJoin();
		expect(app.querySelector('.view-join')).not.toBeNull();
		expect(app.querySelector('textarea')).not.toBeNull();
	});

	test('parsing a valid invite reveals the connect summary', () => {
		gotoJoin();
		(app.querySelector('textarea') as HTMLTextAreaElement).value = armoredInvite();
		[...app.querySelectorAll('button')].find(b => b.textContent === 'Parse')!.click();
		const summary = app.querySelector('.invite-summary') as HTMLElement;
		expect(summary.style.display).not.toBe('none');
		expect(summary.textContent).toContain('r'.repeat(32));
	});

	test('parsing garbage shows a parse error', () => {
		gotoJoin();
		(app.querySelector('textarea') as HTMLTextAreaElement).value = 'not an invite';
		[...app.querySelectorAll('button')].find(b => b.textContent === 'Parse')!.click();
		const err = app.querySelector('.error') as HTMLElement;
		expect(err.style.display).not.toBe('none');
		expect(err.textContent).toContain('Parse error');
	});
});
