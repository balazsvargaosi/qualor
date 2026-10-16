import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  complianceReport,
  FakeCompliance,
  FakeServer,
  me,
  ORG_ADMIN_PERMISSIONS,
  ORG_ID,
  page,
  problem,
  provideFakeServer,
  settle,
} from '../../testing/fake-server';
import type { Me } from '../api/types';
import { SessionStore } from '../auth/session';
import { SettingsCompliancePage } from './compliance.page';
import { ExtensionPage } from './extension.page';
import { SettingsPage } from './settings.page';

const REPORTS = '/api/v0/ee/compliance/reports';
const NAV = {
  point: 'settings.nav',
  id: 'compliance',
  label: 'Compliance reports',
  path: '/settings/ee/compliance',
};
const TAB = { point: 'project.tab', id: 'compliance', label: 'Compliance', path: 'compliance' };
/** A project tab of some other plugin: a settings entry the UI has no screen for would list it. */
const OTHER_TAB = { point: 'project.tab', id: 'other-tab', label: 'Other tab', path: 'other' };

type Who = 'instanceAdmin' | 'orgAdmin' | 'member' | 'grantOnly';

function user(who: Who): Me {
  const base = me({ admin: who === 'instanceAdmin' });
  if (who === 'grantOnly') return { ...base, memberships: [] };
  if (who === 'orgAdmin') {
    return {
      ...base,
      memberships: [
        {
          ...base.memberships[0]!,
          role: 'admin',
          permissions: [...ORG_ADMIN_PERMISSIONS, 'org.compliance.manage'],
        },
      ],
    };
  }
  return base;
}

function setup(who: Who, features = ['compliance-export']): FakeServer {
  const server = new FakeServer();
  server.on('GET', '/api/v0/organizations', {
    body: page([{ id: ORG_ID, key: 'default', name: 'Default', createdAt: '', updatedAt: '' }]),
  });
  server.on('GET', '/api/v0/system/info', {
    body: {
      version: '0.8.0',
      edition: 'enterprise',
      features,
      extensions: features.includes('compliance-export') ? [TAB, NAV, OTHER_TAB] : [OTHER_TAB],
    },
  });
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: '**', children: [] }]), provideFakeServer(server)],
  });
  TestBed.inject(SessionStore).set(user(who));
  return server;
}

async function render(): Promise<HTMLElement> {
  const fixture = TestBed.createComponent(SettingsCompliancePage);
  await settle(fixture);
  return fixture.nativeElement as HTMLElement;
}

describe('SettingsCompliancePage (4E-1 §4)', () => {
  it("lists the current organisation's reports, with Create report for org.compliance.manage", async () => {
    const server = setup('orgAdmin');
    FakeCompliance.install(server, [
      complianceReport({ scope: 'organization', project: null, branch: null, canDelete: true }),
    ]);
    const root = await render();
    expect(root.querySelector('h2')?.textContent?.trim()).toBe('Compliance reports');
    expect(server.requestsTo('GET', REPORTS)[0]?.query.get('organizationId')).toBe(ORG_ID);
    expect(root.querySelectorAll('.compliance-list tbody tr[data-key]')).toHaveLength(1);
    expect(root.textContent).toContain('Create report');
  });

  it('shows a member the list without Create report', async () => {
    const server = setup('member');
    FakeCompliance.install(server, []);
    const root = await render();
    expect(root.querySelector('.empty-state')?.textContent?.trim()).toBe(
      'No compliance reports yet.',
    );
    expect(root.textContent).not.toContain('Create report');
  });

  it('tells a user with project grants only that the reports are for members', async () => {
    const server = setup('grantOnly');
    server.on('GET', REPORTS, { status: 403, body: problem(403, 'FORBIDDEN') });
    const root = await render();
    expect(root.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
      'Only members of the organisation can see its compliance reports.',
    );
    expect(root.querySelector('table')).toBeNull();
    expect(root.textContent).not.toContain('Create report');
  });

  it('says the feature is inactive, and asks the enterprise API nothing, without the licence', async () => {
    const server = setup('orgAdmin', []);
    const root = await render();
    expect(root.textContent).toContain(
      'Compliance reports need an enterprise licence with the compliance-export feature.',
    );
    expect(server.requests.filter((r) => r.path.startsWith('/api/v0/ee/'))).toEqual([]);
  });
});

describe('SettingsPage and the project.tab extension point (4E-1 §4)', () => {
  async function nav(who: Who, features?: string[]): Promise<HTMLAnchorElement[]> {
    setup(who, features);
    const fixture = TestBed.createComponent(SettingsPage);
    await settle(fixture);
    return [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLAnchorElement>('nav a')];
  }

  it('never lists a project tab in the Settings navigation', async () => {
    const links = await nav('instanceAdmin');
    const labels = links.map((a) => a.textContent?.trim());
    const hrefs = links.map((a) => a.getAttribute('href'));
    expect(labels.filter((l) => l === 'Compliance reports')).toHaveLength(1);
    expect(hrefs).toContain('/ee/compliance');
    expect(labels).not.toContain('Compliance');
    expect(labels).not.toContain('Other tab');
    expect(hrefs.some((h) => h?.includes('other'))).toBe(false);
  });

  it('lists Compliance reports under Organization for a member, while the feature is active', async () => {
    const links = await nav('member');
    expect(links.map((a) => a.textContent?.trim())).toContain('Compliance reports');
    TestBed.resetTestingModule();
    const lapsed = await nav('member', []);
    expect(lapsed.map((a) => a.textContent?.trim())).not.toContain('Compliance reports');
  });

  it('answers Not found for a project tab id at /settings/ee/:id', async () => {
    setup('instanceAdmin');
    const fixture = TestBed.createComponent(ExtensionPage);
    fixture.componentRef.setInput('id', 'other-tab');
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('h2')?.textContent?.trim()).toBe('Not found');
  });
});
