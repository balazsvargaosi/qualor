import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FakeServer, me, problem, provideFakeServer, settle } from '../../testing/fake-server';
import type { ResponseBody } from '../api/types';
import { SessionStore } from '../auth/session';
import { McpPage } from './mcp.page';

type McpSettings = ResponseBody<'/api/v0/system/mcp', 'get'>;
const MCP = '/api/v0/system/mcp';

function settings(overrides: Partial<McpSettings> = {}): McpSettings {
  return {
    enabled: true,
    reason: null,
    url: 'https://qualor.example/mcp',
    policy: { dcr: true, cimd: true, allowedClients: [] },
    ...overrides,
  };
}

function setup(answer: McpSettings = settings(), options: { admin?: boolean } = {}): FakeServer {
  const server = new FakeServer();
  server.on('GET', MCP, { body: answer });
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: '**', children: [] }]), provideFakeServer(server)],
  });
  TestBed.inject(SessionStore).set(me({ admin: options.admin ?? true }));
  return server;
}

async function render() {
  const fixture = TestBed.createComponent(McpPage);
  await settle(fixture);
  return { fixture, root: fixture.nativeElement as HTMLElement };
}

function field<T extends HTMLElement>(root: HTMLElement, id: string): T {
  return root.querySelector<T>(`#${id}`)!;
}

function check(root: HTMLElement, id: string, on: boolean): void {
  const box = field<HTMLInputElement>(root, id);
  box.checked = on;
  box.dispatchEvent(new Event('change'));
}

function type(root: HTMLElement, id: string, value: string): void {
  const area = field<HTMLTextAreaElement>(root, id);
  area.value = value;
  area.dispatchEvent(new Event('input'));
}

async function save(fixture: { whenStable(): Promise<unknown> }, root: HTMLElement) {
  root.querySelector('form')!.dispatchEvent(new Event('submit'));
  await settle(fixture);
}

describe('McpPage (spec §9)', () => {
  it('shows the endpoint to copy and the client policy', async () => {
    setup(
      settings({
        policy: { dcr: false, cimd: true, allowedClients: ['qlr_cli_a', 'https://x.example/'] },
      }),
    );
    const { root } = await render();
    expect(field<HTMLInputElement>(root, 'mcp-url').value).toBe('https://qualor.example/mcp');
    expect(field<HTMLInputElement>(root, 'mcp-dcr').checked).toBe(false);
    expect(field<HTMLInputElement>(root, 'mcp-cimd').checked).toBe(true);
    expect(field<HTMLTextAreaElement>(root, 'mcp-allowed').value).toBe(
      'qlr_cli_a\nhttps://x.example/',
    );
    expect(root.textContent).not.toContain('QUALOR_PUBLIC_URL');
  });

  it('saves the switches and the allow-list, one entry per line', async () => {
    const server = setup();
    server.on('PUT', MCP, (request) => ({
      body: settings({ policy: request.body as McpSettings['policy'] }),
    }));
    const { fixture, root } = await render();
    check(root, 'mcp-dcr', false);
    type(root, 'mcp-allowed', '  qlr_cli_a \n\nhttps://x.example/\n');
    await save(fixture, root);
    expect(server.requestsTo('PUT', MCP)[0]?.body).toEqual({
      dcr: false,
      cimd: true,
      allowedClients: ['qlr_cli_a', 'https://x.example/'],
    });
    expect(root.querySelector('[role=status]')?.textContent).toContain(
      'The MCP settings were saved.',
    );
    expect(field<HTMLTextAreaElement>(root, 'mcp-allowed').value).toBe(
      'qlr_cli_a\nhttps://x.example/',
    );
  });

  it('refuses an entry with spaces before sending', async () => {
    const server = setup();
    const { fixture, root } = await render();
    type(root, 'mcp-allowed', 'qlr_cli_a b');
    await save(fixture, root);
    expect(server.requestsTo('PUT', MCP)).toEqual([]);
    expect(root.querySelector('#mcp-allowed-error')?.textContent).toContain(
      'One client id or URL prefix per line',
    );
    expect(field(root, 'mcp-allowed').getAttribute('aria-invalid')).toBe('true');
  });

  it('shows a refused allow-list on its field (422)', async () => {
    const server = setup();
    server.on('PUT', MCP, {
      status: 422,
      body: problem(422, 'VALIDATION_FAILED', [{ path: 'body.allowedClients', message: 'x' }]),
    });
    const { fixture, root } = await render();
    await save(fixture, root);
    expect(root.querySelector('#mcp-allowed-error')?.textContent).toContain(
      'One client id or URL prefix per line',
    );
  });

  it('says how to turn the endpoint on when QUALOR_PUBLIC_URL is not set', async () => {
    setup(settings({ enabled: false, reason: 'PUBLIC_URL_MISSING', url: null }));
    const { root } = await render();
    expect(root.textContent).toContain('Set QUALOR_PUBLIC_URL to turn the MCP endpoint on.');
    expect(root.querySelector('#mcp-url')).toBeNull();
    // The policy can still be prepared.
    expect(root.querySelector('#mcp-dcr')).not.toBeNull();
  });

  it('asks the server nothing for someone who is not an instance admin', async () => {
    const server = setup(settings(), { admin: false });
    const { root } = await render();
    expect(root.textContent).toContain('Only instance administrators change the MCP settings.');
    expect(server.requestsTo('GET', MCP)).toEqual([]);
  });
});
