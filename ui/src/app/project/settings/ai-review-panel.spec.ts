import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FakeServer, ORG_ID, provideFakeServer, settle } from '../../../testing/fake-server';
import type { ProjectDto } from '../current-project';
import { AiReviewPanel } from './ai-review-panel';

const PROJECT = '0190a6c2-0000-7000-8000-0000000000f1';

function project(aiReview: ProjectDto['aiReview']): ProjectDto {
  return {
    id: PROJECT,
    organizationId: ORG_ID,
    key: 'acme/payments',
    name: 'Payments',
    mainBranchName: 'main',
    permissions: ['project.read', 'project.settings'],
    aiReview,
  } as ProjectDto;
}

function setup(): FakeServer {
  const server = new FakeServer();
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: '**', children: [] }]), provideFakeServer(server)],
  });
  return server;
}

async function render(aiReview: ProjectDto['aiReview']) {
  const fixture = TestBed.createComponent(AiReviewPanel);
  fixture.componentRef.setInput('project', project(aiReview));
  await settle(fixture);
  return { fixture, root: fixture.nativeElement as HTMLElement };
}

describe('AiReviewPanel (6I-2 Task 9)', () => {
  it('renders its section, which the settings index links to', async () => {
    setup();
    const { root } = await render({ enabled: true, organizationEnabled: true });
    const section = root.querySelector('section.card.panel')!;
    expect(section.id).toBe('ai-review');
    expect(section.querySelector('.panel-head h2')?.textContent?.trim()).toBe('AI review');
  });

  it('says AI review is on for the project', async () => {
    const server = setup();
    const { root } = await render({ enabled: true, organizationEnabled: true });
    expect(root.querySelector('#ai-review-state')?.textContent?.trim()).toBe(
      'AI review is on for this project.',
    );
    // Nothing to ask the organisation admin for.
    expect(root.querySelector('#ai-review-organization-off')).toBeNull();
    expect(server.requests).toHaveLength(0);
  });

  it('says AI review is off for the project while its organisation has it on', async () => {
    const server = setup();
    const { root } = await render({ enabled: false, organizationEnabled: true });
    expect(root.querySelector('#ai-review-state')?.textContent?.trim()).toBe(
      'AI review is off for this project.',
    );
    expect(root.querySelector('#ai-review-organization-off')).toBeNull();
    expect(server.requests).toHaveLength(0);
  });

  it('says the organisation admin switches it on in Settings → AI review while the organisation has it off', async () => {
    const server = setup();
    const { root } = await render({ enabled: false, organizationEnabled: false });
    expect(root.querySelector('#ai-review-state')?.textContent?.trim()).toBe(
      'AI review is off for this project.',
    );
    const note = root.querySelector('#ai-review-organization-off')!;
    expect(note.textContent?.trim()).toBe(
      'Your organisation admin switches it on in Settings → AI review.',
    );
    expect(note.querySelector('a')?.getAttribute('href')).toBe('/settings/ai-review');
    expect(note.querySelector('a')?.textContent?.trim()).toBe('Settings → AI review');
    expect(server.requests).toHaveLength(0);
  });

  it('is read-only: it has no control to change anything', async () => {
    setup();
    const { root } = await render({ enabled: false, organizationEnabled: false });
    expect(root.querySelectorAll('input, button, select, textarea')).toHaveLength(0);
  });

  it('follows the project when it is read again', async () => {
    setup();
    const { fixture, root } = await render({ enabled: false, organizationEnabled: true });
    fixture.componentRef.setInput('project', project({ enabled: true, organizationEnabled: true }));
    await settle(fixture);
    expect(root.querySelector('#ai-review-state')?.textContent?.trim()).toBe(
      'AI review is on for this project.',
    );
  });
});
