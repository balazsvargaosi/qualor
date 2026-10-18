import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FakeServer, me, problem, provideFakeServer, settle } from '../../testing/fake-server';
import type { ResponseBody } from '../api/types';
import { SessionStore } from '../auth/session';
import { LEAVE_APP } from '../shared/leave-app';
import { ConsentPage } from './consent.page';

type Pending = ResponseBody<'/api/v0/oauth/requests/{id}', 'get'>;

const ID = '0190a6c2-0000-7000-8000-0000000000a1';
const REQUEST = `/api/v0/oauth/requests/${ID}`;
const DECISION = `${REQUEST}/decision`;
const BACK = 'http://127.0.0.1:33418/callback?code=qlr_oac_x&state=s1&iss=x';

function pending(overrides: Partial<Pending> = {}, client: Partial<Pending['client']> = {}) {
  return {
    id: ID,
    client: {
      clientId: 'https://agent.example/client.json',
      name: 'Agent Studio',
      source: 'cimd' as const,
      logoUri: 'https://agent.example/logo.png',
      clientUri: 'https://agent.example',
      redirectTarget: 'agent.example',
      redirectUri: 'https://agent.example/callback',
      ...client,
    },
    scopes: ['mcp:read', 'mcp:write'] as Pending['scopes'],
    expiresAt: '2026-10-18T10:10:00.000Z',
    coveredByGrant: false,
    ...overrides,
  } satisfies Pending;
}

function setup(answer: Pending | null = pending(), options: { demo?: boolean } = {}) {
  const server = new FakeServer();
  const leave = vi.fn();
  if (answer) server.on('GET', REQUEST, { body: answer });
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '**', children: [] }]),
      provideFakeServer(server),
      { provide: LEAVE_APP, useValue: leave },
    ],
  });
  TestBed.inject(SessionStore).set(me({ demo: options.demo ?? false }));
  return { server, leave };
}

async function render() {
  const fixture = TestBed.createComponent(ConsentPage);
  fixture.componentRef.setInput('request', ID);
  await settle(fixture);
  return { fixture, root: fixture.nativeElement as HTMLElement };
}

function button(root: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
}

describe('ConsentPage (spec §6 step 6)', () => {
  it('names the app, the account, what it may do and where the browser goes back to', async () => {
    setup();
    const { root } = await render();
    expect(root.querySelector('h1')?.textContent).toContain('Agent Studio');
    expect(root.textContent).toContain('wants to access Qualor as alice.');
    expect(root.textContent).toContain('Read projects, quality gates, issues and measures');
    expect(root.textContent).toContain('Ask the AI assistant');
    const write = root.querySelector<HTMLInputElement>('#consent-write');
    expect(write?.checked).toBe(true);
    expect(root.querySelector('label[for="consent-write"]')?.textContent).toContain(
      'Change issue statuses (false positive, won’t fix) with a comment',
    );
    expect(root.textContent).toContain('After you answer, your browser goes to agent.example.');
    // An https address is named by its host alone, and a logo is never loaded (CSP img-src).
    expect(root.querySelector('[data-test=redirect-uri]')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).not.toContain('Not verified');
  });

  it('marks an app that registered itself, and shows a redirect that is not https in full', async () => {
    setup(
      pending(
        { scopes: ['mcp:read'] },
        {
          source: 'dcr',
          clientId: 'qlr_cli_abc',
          redirectTarget: 'this computer (127.0.0.1)',
          redirectUri: 'http://127.0.0.1:33418/callback',
        },
      ),
    );
    const { root } = await render();
    expect(root.textContent).toContain('Not verified: this app registered itself.');
    expect(root.textContent).toContain('After you answer, your browser goes to this computer.');
    expect(root.querySelector('[data-test=redirect-uri]')?.textContent).toBe(
      'http://127.0.0.1:33418/callback',
    );
    // Only read was asked for: there is nothing to choose.
    expect(root.querySelector('#consent-write')).toBeNull();
  });

  it('Allow sends the scopes as chosen, then follows the answered address', async () => {
    const { server, leave } = setup();
    server.on('POST', DECISION, { body: { redirectTo: BACK } });
    const { fixture, root } = await render();
    const write = root.querySelector<HTMLInputElement>('#consent-write')!;
    write.checked = false;
    write.dispatchEvent(new Event('change'));
    button(root, 'Allow')!.click();
    await settle(fixture);
    const [sent] = server.requestsTo('POST', DECISION);
    expect(sent?.body).toEqual({ decision: 'approve', scopes: ['mcp:read'] });
    expect(sent?.headers.get('x-qualor-csrf')).toBe('csrf-token');
    expect(leave).toHaveBeenCalledWith(BACK);
  });

  it('Allow with the box checked sends read and write', async () => {
    const { server, leave } = setup();
    server.on('POST', DECISION, { body: { redirectTo: BACK } });
    const { fixture, root } = await render();
    button(root, 'Allow')!.click();
    await settle(fixture);
    expect(server.requestsTo('POST', DECISION)[0]?.body).toEqual({
      decision: 'approve',
      scopes: ['mcp:read', 'mcp:write'],
    });
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('Deny sends the refusal and follows its address', async () => {
    const { server, leave } = setup();
    const denied = 'https://agent.example/callback?error=access_denied&state=s1';
    server.on('POST', DECISION, { body: { redirectTo: denied } });
    const { fixture, root } = await render();
    button(root, 'Deny')!.click();
    await settle(fixture);
    expect(server.requestsTo('POST', DECISION)[0]?.body).toEqual({ decision: 'deny' });
    expect(leave).toHaveBeenCalledWith(denied);
  });

  it('approves at once, without the form, when a grant already covers the request', async () => {
    const { server, leave } = setup(pending({ coveredByGrant: true }));
    server.on('POST', DECISION, { body: { redirectTo: BACK } });
    const { root } = await render();
    expect(server.requestsTo('POST', DECISION)[0]?.body).toEqual({
      decision: 'approve',
      scopes: ['mcp:read', 'mcp:write'],
    });
    expect(leave).toHaveBeenCalledWith(BACK);
    expect(button(root, 'Allow')).toBeUndefined();
  });

  it('says the request is gone when the server does not know it (404)', async () => {
    const { leave } = setup(null);
    const { root } = await render();
    expect(root.querySelector('[role=alert]')?.textContent).toContain(
      'This request has expired or was already answered.',
    );
    expect(button(root, 'Allow')).toBeUndefined();
    expect(leave).not.toHaveBeenCalled();
  });

  it('says the request is gone when it expires before the answer (404 on the decision)', async () => {
    const { server, leave } = setup();
    server.on('POST', DECISION, { status: 404, body: problem(404, 'NOT_FOUND') });
    const { fixture, root } = await render();
    button(root, 'Allow')!.click();
    await settle(fixture);
    expect(root.querySelector('[role=alert]')?.textContent).toContain(
      'This request has expired or was already answered.',
    );
    expect(button(root, 'Allow')).toBeUndefined();
    expect(leave).not.toHaveBeenCalled();
  });

  it('explains 403 CLIENT_NOT_ALLOWED and leaves Deny so the app learns the answer', async () => {
    const { server, leave } = setup();
    server.on('POST', DECISION, { status: 403, body: problem(403, 'CLIENT_NOT_ALLOWED') });
    const { fixture, root } = await render();
    button(root, 'Allow')!.click();
    await settle(fixture);
    expect(root.querySelector('[role=alert]')?.textContent).toContain(
      'The administrator of this server does not allow this app.',
    );
    expect(button(root, 'Allow')).toBeUndefined();
    expect(document.activeElement).toBe(button(root, 'Deny'));
    expect(leave).not.toHaveBeenCalled();
  });

  it('shows the form with the error when an automatic approval fails', async () => {
    const { server, leave } = setup(pending({ coveredByGrant: true }));
    server.on('POST', DECISION, { status: 500, body: problem(500, 'INTERNAL') });
    const { root } = await render();
    expect(root.querySelector('[role=alert]')?.textContent).toContain('The request failed');
    expect(button(root, 'Allow')).toBeDefined();
    expect(leave).not.toHaveBeenCalled();
  });

  it('offers no answer in the read-only demo', async () => {
    const { server } = setup(pending(), { demo: true });
    const { root } = await render();
    expect(root.textContent).toContain('The demo is read-only, so it cannot connect apps.');
    expect(button(root, 'Allow')).toBeUndefined();
    expect(server.requestsTo('POST', DECISION)).toEqual([]);
  });
});
