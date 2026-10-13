import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  FakeAutoFix,
  FakeServer,
  ORG_ID,
  problem,
  provideFakeServer,
  settle,
} from '../../../testing/fake-server';
import type { ProjectDto } from '../current-project';
import { AutoFixPanel } from './auto-fix-panel';

const PROJECT = '0190a6c2-0000-7000-8000-0000000000f1';
const ROUTE = `/api/v0/projects/${PROJECT}/ai/auto-fix`;

function project(autoFix: ProjectDto['autoFix']): ProjectDto {
  return {
    id: PROJECT,
    organizationId: ORG_ID,
    key: 'acme/payments',
    name: 'Payments',
    mainBranchName: 'main',
    permissions: ['project.read', 'project.settings'],
    autoFix,
  } as ProjectDto;
}

function setup(): FakeServer {
  const server = new FakeServer();
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: '**', children: [] }]), provideFakeServer(server)],
  });
  return server;
}

async function render(
  autoFix: ProjectDto['autoFix'] = { available: true, enabled: true, organizationEnabled: true },
) {
  const fixture = TestBed.createComponent(AutoFixPanel);
  fixture.componentRef.setInput('project', project(autoFix));
  const saved = vi.fn();
  fixture.componentInstance.saved.subscribe(saved);
  await settle(fixture);
  return { fixture, saved, root: fixture.nativeElement as HTMLElement };
}

const toggle = (root: HTMLElement) => root.querySelector<HTMLInputElement>('#auto-fix-project')!;
const save = (root: HTMLElement) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save')!;

describe('AutoFixPanel (4E-3a §2, §4)', () => {
  it('renders its section and the switch, on while the project is not opted out', async () => {
    setup();
    const { root } = await render();
    const section = root.querySelector('section.card.panel')!;
    expect(section.id).toBe('auto-fix');
    expect(section.querySelector('.panel-head h2')?.textContent?.trim()).toBe(
      'Automatic fix suggestions',
    );
    expect(root.querySelector('label[for="auto-fix-project"]')?.textContent?.trim()).toBe(
      'Automatic fix suggestions for this project',
    );
    expect(toggle(root).checked).toBe(true);
    expect(root.textContent).toContain(
      'only while the organisation has automatic fix suggestions switched on',
    );
    expect(save(root).disabled).toBe(true);
  });

  it('opts the project out, says so and tells the page', async () => {
    const server = setup();
    const fake = new FakeAutoFix(server);
    const { fixture, root, saved } = await render();
    toggle(root).click();
    await settle(fixture);
    expect(save(root).disabled).toBe(false);
    save(root).click();
    await settle(fixture);
    expect(server.requestsTo('PUT', ROUTE)[0]?.body).toEqual({ enabled: false });
    expect(fake.optedOut.has(PROJECT)).toBe(true);
    expect(root.querySelector('[role="status"]')?.textContent).toContain(
      'Automatic fix suggestions are off for this project.',
    );
    expect(saved).toHaveBeenCalledOnce();
  });

  it('opts a project back in', async () => {
    const server = setup();
    new FakeAutoFix(server);
    const { fixture, root } = await render({
      available: true,
      enabled: false,
      organizationEnabled: true,
    });
    expect(toggle(root).checked).toBe(false);
    toggle(root).click();
    await settle(fixture);
    save(root).click();
    await settle(fixture);
    expect(server.requestsTo('PUT', ROUTE)[0]?.body).toEqual({ enabled: true });
    expect(root.querySelector('[role="status"]')?.textContent).toContain(
      'Automatic fix suggestions are on for this project while the organisation has them on.',
    );
  });

  it('explains instead of a switch without the licence, and asks the server nothing', async () => {
    const server = setup();
    const { root } = await render({ available: false, enabled: true, organizationEnabled: false });
    expect(root.querySelector('#auto-fix-project')).toBeNull();
    expect(root.textContent).toContain('Automatic fix suggestions need the Enterprise plan.');
    expect(server.requests).toHaveLength(0);
  });

  it('explains instead of a switch while the organisation has them off, pointing to its settings', async () => {
    const server = setup();
    const { root } = await render({ available: true, enabled: false, organizationEnabled: false });
    expect(root.querySelector('#auto-fix-project')).toBeNull();
    const note = root.querySelector('#auto-fix-organization-off')!;
    expect(note.textContent).toContain(
      'The organisation has automatic fix suggestions switched off, so none are posted for this project.',
    );
    expect(note.querySelector('a')?.getAttribute('href')).toBe('/settings/auto-fix');
    expect(note.querySelector('a')?.textContent?.trim()).toBe('Settings → Automatic fixes');
    expect(server.requests).toHaveLength(0);
  });

  it('says so when the organisation has 1 000 projects opted out (409)', async () => {
    const server = setup();
    server.on('PUT', ROUTE, {
      status: 409,
      body: problem(409, 'AUTO_FIX_OPT_OUT_LIMIT_REACHED'),
    });
    const { fixture, root, saved } = await render();
    toggle(root).click();
    await settle(fixture);
    save(root).click();
    await settle(fixture);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'This organisation already has 1 000 projects opted out.',
    );
    expect(saved).not.toHaveBeenCalled();
  });
});
