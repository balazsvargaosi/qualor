import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Me } from '../../api/types';
import { SessionStore } from '../../auth/session';
import { OrgContext } from '../../org/org-context';
import { orgAi } from '../../../testing/ai-settings';
import {
  FakeAutoFix,
  FakeServer,
  me,
  ORG_ID,
  page,
  problem,
  projectItem,
  provideFakeServer,
  settle,
} from '../../../testing/fake-server';
import type { ProjectDto } from '../current-project';
import { ProjectAiPanel } from './ai-panel';

const PROJECT = '0190a6c2-0000-7000-8000-0000000000f1';
const ROUTE = `/api/v0/projects/${PROJECT}/ai/auto-fix`;
const ORG_AI = `/api/v0/organizations/${ORG_ID}/ai`;
const NO_FEATURES = { explain: false, triage: false, fix: false };
const OTHER_ORG = '0190a6c2-0000-7000-8000-000000000002';

type Reason = ProjectDto['aiReview']['reason'];
type Who = 'projectAdmin' | 'orgAdmin' | 'instanceAdmin';

/** Payments, linked to a repository, AI review running, fix suggestions on, by default. */
function project(
  over: {
    reason?: Reason;
    autoFix?: Partial<ProjectDto['autoFix']>;
    scmConnectionId?: string | null;
    organizationId?: string;
  } = {},
): ProjectDto {
  const reason = over.reason === undefined ? null : over.reason;
  const selected = reason === null || reason === 'not_mapped' || reason === 'consent_outdated';
  return projectItem({
    id: PROJECT,
    key: 'acme/payments',
    name: 'Payments',
    organizationId: over.organizationId ?? ORG_ID,
    scmConnectionId: over.scmConnectionId === undefined ? 'c1' : over.scmConnectionId,
    permissions: ['project.read', 'project.settings'],
    autoFix: { available: true, enabled: true, organizationEnabled: true, ...over.autoFix },
    aiReview: {
      enabled: selected,
      organizationEnabled: reason === null || reason === 'not_mapped',
      reason,
    },
  });
}

/** A project admin (a member of Default), an org admin who is no instance admin, or both. */
function person(who: Who): Me {
  if (who === 'projectAdmin') return me();
  const admin = me({ admin: true });
  return who === 'instanceAdmin'
    ? admin
    : { ...admin, user: { ...admin.user, isInstanceAdmin: false } };
}

/** The organisation's assistant as `GET /organizations/{id}/ai` answers it for a reason. */
function assistantFor(reason: Reason) {
  if (reason === 'no_provider') {
    return { ...orgAi({ enabled: false, features: NO_FEATURES }), provider: null };
  }
  if (reason === 'organization_disabled') return orgAi({ enabled: false, features: NO_FEATURES });
  return orgAi({ features: { explain: true, triage: true, fix: true } });
}

function setup(who: Who = 'projectAdmin', assistant: object = assistantFor(null)): FakeServer {
  const server = new FakeServer();
  server.on('GET', '/api/v0/organizations', {
    body: page([{ id: ORG_ID, key: 'default', name: 'Default', createdAt: '', updatedAt: '' }]),
  });
  server.on('GET', ORG_AI, { body: assistant });
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: '**', children: [] }]), provideFakeServer(server)],
  });
  TestBed.inject(SessionStore).set(person(who));
  return server;
}

async function render(given: ProjectDto = project()) {
  const fixture = TestBed.createComponent(ProjectAiPanel);
  fixture.componentRef.setInput('project', given);
  const saved = vi.fn();
  fixture.componentInstance.saved.subscribe(saved);
  await settle(fixture);
  return { fixture, saved, root: fixture.nativeElement as HTMLElement };
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();
const line = (root: HTMLElement, name: 'review' | 'assistant' | 'fixes') =>
  root.querySelector<HTMLElement>(`.setting-row[data-line="${name}"]`);
/** A line's state chip and its sentence. */
const stateOf = (root: HTMLElement, name: 'review' | 'assistant' | 'fixes') => ({
  state: text(line(root, name)?.querySelector('.state-line .badge')),
  sentence: text(line(root, name)?.querySelector('.state-line > span:not(.badge)')),
});
const toggle = (root: HTMLElement) => root.querySelector<HTMLInputElement>('#project-ai-fix');

interface Row {
  name: string;
  reason: Reason;
  excluded?: boolean;
  state: string;
  /** The chip's tone: works, set up but stopped, or off. */
  badge: 'badge-passed' | 'badge-warn' | 'badge-none';
  sentence: string;
  requirement?: string;
}

/** Each reason AI review does not run, or that it does, as a project admin reads it. */
const ROWS: readonly Row[] = [
  {
    name: 'reviewed',
    reason: null,
    state: 'Reviewed',
    badge: 'badge-passed',
    sentence: "Reviews this project's merge requests, with ollama:11434.",
  },
  {
    name: 'not linked to a repository',
    reason: 'not_mapped',
    state: 'Not reviewed',
    badge: 'badge-warn',
    sentence: 'Selected, but not reviewed.',
    requirement:
      'This project is not linked to a GitLab or GitHub repository, where reviews are posted. An organization admin links it in Settings → Repositories.',
  },
  {
    name: 'not selected',
    reason: 'project_not_selected',
    state: 'Off',
    badge: 'badge-none',
    sentence:
      'Default reviews selected projects only, and this is not one of them. An organization admin adds it in Settings → AI.',
  },
  {
    name: 'paused for a new provider',
    reason: 'consent_outdated',
    state: 'Paused',
    badge: 'badge-warn',
    sentence: 'Paused until an organization admin confirms the new AI provider in Settings → AI.',
  },
  {
    name: 'not switched on',
    reason: 'review_disabled',
    state: 'Off',
    badge: 'badge-none',
    sentence:
      'Default has not switched on AI review. An organization admin switches it on in Settings → AI.',
  },
  {
    name: 'the organization may not use AI',
    reason: 'organization_disabled',
    state: 'Off',
    badge: 'badge-none',
    sentence: 'Default may not use AI. An instance admin allows it in Settings → AI provider.',
  },
  {
    name: 'no provider',
    reason: 'no_provider',
    state: 'Off',
    badge: 'badge-none',
    sentence:
      "AI isn't set up on this server. An instance admin connects a provider in Settings → AI provider.",
  },
  {
    name: 'excluded from AI, whatever the organization does',
    reason: 'project_not_selected',
    excluded: true,
    state: 'Off',
    badge: 'badge-none',
    sentence: 'An instance admin excluded this project from AI, so nothing of it is sent.',
  },
];

describe('ProjectAiPanel', () => {
  it('is the settings section the index links to, with its purpose', async () => {
    setup();
    const { root } = await render();
    const section = root.querySelector('section.card.panel')!;
    expect(section.id).toBe('ai');
    const heading = section.querySelector('.panel-head h2')!;
    expect(text(heading)).toBe('AI');
    expect(section.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(text(section.querySelector('.sec-purpose'))).toBe(
      "What AI does for this project's merge requests and issues.",
    );
    expect([...section.querySelectorAll('.setting-row .setting-name')].map((e) => text(e))).toEqual(
      ['AI review', 'Assistant', 'Fixes'],
    );
    // A project that is not excluded has no chip in the head.
    expect(section.querySelector('.sec-chips')).toBeNull();
  });

  describe('the AI review line', () => {
    it.each(ROWS)('says why: $name', async (row) => {
      setup('projectAdmin', assistantFor(row.reason));
      const { root } = await render(
        project({ reason: row.reason, autoFix: { excludedFromAi: row.excluded ?? false } }),
      );
      expect(stateOf(root, 'review')).toEqual({ state: row.state, sentence: row.sentence });
      expect(line(root, 'review')?.querySelector('.state-line .badge')?.classList).toContain(
        row.badge,
      );
      const requirement = line(root, 'review')?.querySelector('.req');
      expect(text(requirement)).toBe(row.requirement);
      // The project admin cannot open the places: they are named only.
      expect(line(root, 'review')?.querySelector('.state-line a, .req a')).toBeNull();
    });

    it('says it reviews before the provider is known, and names it once it is', async () => {
      const server = setup();
      let answer!: () => void;
      server.on(
        'GET',
        ORG_AI,
        () =>
          new Promise((resolve) => {
            answer = () => resolve({ body: assistantFor(null) });
          }),
      );
      // Rendered while the organization's answer is held back: waiting for a stable fixture would
      // wait for that answer.
      const fixture = TestBed.createComponent(ProjectAiPanel);
      fixture.componentRef.setInput('project', project());
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve));
        fixture.detectChanges();
      }
      const root = fixture.nativeElement as HTMLElement;
      expect(server.requestsTo('GET', ORG_AI)).toHaveLength(1);
      expect(stateOf(root, 'review')).toEqual({
        state: 'Reviewed',
        sentence: "Reviews this project's merge requests.",
      });
      answer();
      await settle(fixture);
      expect(stateOf(root, 'review').sentence).toBe(
        "Reviews this project's merge requests, with ollama:11434.",
      );
    });

    it('says it reviews when the provider could not be read', async () => {
      const server = setup();
      server.on('GET', ORG_AI, { status: 500, body: problem(500, 'INTERNAL') });
      const { root } = await render();
      expect(stateOf(root, 'review')).toEqual({
        state: 'Reviewed',
        sentence: "Reviews this project's merge requests.",
      });
    });

    it('says who chooses the projects, and that the CI must scan merge requests with the full history', async () => {
      setup();
      const { root } = await render();
      expect(text(line(root, 'review')?.querySelector('.setting-text p'))).toBe(
        "Default's organization admins choose the projects.",
      );
      const hint = line(root, 'review')?.querySelector('.setting-field p.hint');
      expect(text(hint)).toBe(
        'Your CI must scan merge requests with the full history: What your CI needs.',
      );
      expect(hint?.querySelector('a')?.getAttribute('href')).toBe(
        '/docs/ai-review#what-your-ci-needs',
      );
    });

    it('links the place for someone who can open it, and names it for someone who cannot', async () => {
      setup('orgAdmin');
      const { fixture, root } = await render(project({ reason: 'review_disabled' }));
      const off = line(root, 'review')!.querySelector('.state-line')!;
      expect(text(off.querySelector('a[href="/settings/ai-review"]'))).toBe('Settings → AI');
      // An organisation admin who is no instance admin cannot open the AI provider's page.
      fixture.componentRef.setInput('project', project({ reason: 'organization_disabled' }));
      await settle(fixture);
      expect(text(line(root, 'review')?.querySelector('.state-line > span:not(.badge)'))).toBe(
        'Default may not use AI. An instance admin allows it in Settings → AI provider.',
      );
      expect(line(root, 'review')?.querySelector('.state-line a')).toBeNull();
      // The link to the repositories in the requirement of a project not linked to one.
      fixture.componentRef.setInput('project', project({ reason: 'not_mapped' }));
      await settle(fixture);
      expect(
        line(root, 'review')?.querySelector('.req a[href="/settings/repositories"]'),
      ).not.toBeNull();
    });

    it("links an organization's place only while the header shows the project's organization", async () => {
      const server = setup('orgAdmin');
      server.on('GET', '/api/v0/organizations', {
        body: page([
          { id: ORG_ID, key: 'default', name: 'Default', createdAt: '', updatedAt: '' },
          { id: OTHER_ORG, key: 'research', name: 'Research', createdAt: '', updatedAt: '' },
        ]),
      });
      // An admin of both organizations.
      const admin = person('orgAdmin');
      const membership = admin.memberships[0]!;
      TestBed.inject(SessionStore).set({
        ...admin,
        memberships: [
          membership,
          {
            ...membership,
            organizationId: OTHER_ORG,
            organizationKey: 'research',
            organizationName: 'Research',
          },
        ],
      });
      const org = TestBed.inject(OrgContext);
      onTestFinished(() => localStorage.removeItem('qualor.organizationId'));
      const { fixture, root } = await render(
        project({ reason: 'not_mapped', autoFix: { organizationEnabled: false } }),
      );
      expect(org.currentId()).toBe(ORG_ID);
      expect(
        line(root, 'review')?.querySelector('.req a[href="/settings/repositories"]'),
      ).not.toBeNull();
      expect(
        line(root, 'fixes')?.querySelector('.req a[href="/settings/ai-review"]'),
      ).not.toBeNull();

      // The header shows Research: the pages would be Research's, so the places are named only.
      org.select(OTHER_ORG);
      await settle(fixture);
      expect(line(root, 'review')?.querySelector('a')).toBeNull();
      expect(text(line(root, 'review')?.querySelector('.req'))).toBe(
        'This project is not linked to a GitLab or GitHub repository, where reviews are posted. An organization admin links it in Settings → Repositories.',
      );
      expect(line(root, 'fixes')?.querySelector('a')).toBeNull();
      fixture.componentRef.setInput('project', project({ reason: 'project_not_selected' }));
      await settle(fixture);
      expect(line(root, 'review')?.querySelector('.state-line a')).toBeNull();
      expect(stateOf(root, 'review').sentence).toBe(
        'Default reviews selected projects only, and this is not one of them. An organization admin adds it in Settings → AI.',
      );

      org.select(ORG_ID);
      await settle(fixture);
      expect(
        line(root, 'review')?.querySelector('.state-line a[href="/settings/ai-review"]'),
      ).not.toBeNull();
    });

    it('links the AI provider for an instance admin', async () => {
      setup('instanceAdmin', assistantFor('no_provider'));
      const { root } = await render(project({ reason: 'no_provider' }));
      expect(text(line(root, 'review')?.querySelector('.state-line a[href="/settings/ai"]'))).toBe(
        'Settings → AI provider',
      );
    });

    it('follows the project when it is read again, and reads the assistant once per organization', async () => {
      const server = setup();
      const { fixture, root } = await render(project({ reason: 'review_disabled' }));
      expect(stateOf(root, 'review').state).toBe('Off');
      fixture.componentRef.setInput('project', project());
      await settle(fixture);
      expect(stateOf(root, 'review').state).toBe('Reviewed');
      expect(server.requestsTo('GET', ORG_AI)).toHaveLength(1);
    });
  });

  describe('the Assistant line', () => {
    it('names the features on for the project’s issues', async () => {
      setup('projectAdmin', orgAi({ features: { explain: true, triage: false, fix: true } }));
      const { root } = await render();
      expect(stateOf(root, 'assistant')).toEqual({
        state: 'Available',
        sentence: "Explain and Suggest a fix on this project's issues.",
      });
    });

    it('names all three when all are on, as the page’s locale lists them', async () => {
      setup();
      const { root } = await render();
      expect(stateOf(root, 'assistant').sentence).toBe(
        "Explain, Suggest triage, and Suggest a fix on this project's issues.",
      );
    });

    it.each([
      {
        name: 'no provider',
        assistant: assistantFor('no_provider'),
        reason: 'no_provider' as Reason,
        // The AI review line above says why, and who changes it where.
        sentence: 'For the same reason.',
      },
      {
        name: 'the organization may not use AI',
        assistant: assistantFor('organization_disabled'),
        reason: 'organization_disabled' as Reason,
        sentence: 'For the same reason.',
      },
      {
        name: 'no feature on',
        assistant: orgAi({ features: NO_FEATURES }),
        reason: null,
        sentence: 'Default has none of Explain, Suggest triage and Suggest a fix on.',
      },
    ])('is not available, and says the first reason: $name', async (row) => {
      setup('projectAdmin', row.assistant);
      const { root } = await render(project({ reason: row.reason }));
      expect(stateOf(root, 'assistant')).toEqual({
        state: 'Not available',
        sentence: row.sentence,
      });
    });

    it('says why the organization’s assistant could not be read', async () => {
      const server = setup();
      server.on('GET', ORG_AI, { status: 500, body: problem(500, 'INTERNAL') });
      const { root } = await render();
      expect(line(root, 'assistant')?.querySelector('[role="alert"]')).not.toBeNull();
      expect(line(root, 'assistant')?.querySelector('.state-line')).toBeNull();
    });
  });

  describe('the Fixes line', () => {
    it('is a switch named by its name alone, described by its help', async () => {
      setup();
      const { root } = await render();
      const fix = toggle(root)!;
      expect(fix.getAttribute('role')).toBe('switch');
      expect(fix.checked).toBe(true);
      expect(fix.disabled).toBe(false);
      const name = root.querySelector(`#${fix.getAttribute('aria-labelledby')}`);
      expect(text(name)).toBe(
        "Post fix suggestions to this project's merge requests automatically",
      );
      const described = fix.getAttribute('aria-describedby')!.split(' ');
      expect(described.map((id) => text(root.querySelector(`#${id}`)))).toEqual([
        'Default posts them for new findings, as its organization admins set. Switch it off to keep them for a person to ask for.',
      ]);
      expect(line(root, 'fixes')?.querySelector('.req')).toBeNull();
    });

    it('saves the fix suggestions switch at once, and flips it back on a refusal', async () => {
      const server = setup();
      const fake = FakeAutoFix.install(server);
      const { fixture, root, saved } = await render();
      const fix = toggle(root)!;
      fix.focus();
      fix.click();
      await settle(fixture);
      expect(server.requestsTo('PUT', ROUTE).map((r) => r.body)).toEqual([{ enabled: false }]);
      expect(fake.optedOut.has(PROJECT)).toBe(true);
      expect(fix.checked).toBe(false);
      expect(text(line(root, 'fixes')?.querySelector('[role="status"]'))).toBe('Saved.');
      expect(saved).toHaveBeenCalledOnce();

      fix.click();
      await settle(fixture);
      expect(server.requestsTo('PUT', ROUTE).map((r) => r.body)).toEqual([
        { enabled: false },
        { enabled: true },
      ]);
      expect(fix.checked).toBe(true);
      expect(saved).toHaveBeenCalledTimes(2);

      server.on('PUT', ROUTE, {
        status: 409,
        body: problem(409, 'AUTO_FIX_OPT_OUT_LIMIT_REACHED'),
      });
      fix.click();
      await settle(fixture);
      expect(server.requestsTo('PUT', ROUTE)).toHaveLength(3);
      expect(fix.checked).toBe(true);
      expect(text(line(root, 'fixes')?.querySelector('[role="alert"]'))).toBe(
        'This organisation already has 1 000 projects opted out. Switch one back on first.',
      );
      expect(text(line(root, 'fixes')?.querySelector('[role="status"]'))).toBe('');
      expect(saved).toHaveBeenCalledTimes(2);
      // The focus stays on the switch, to try again.
      expect(document.activeElement).toBe(fix);
    });

    it('says the plan is missing when the server refuses for the licence', async () => {
      const server = setup();
      server.on('PUT', ROUTE, { status: 403, body: problem(403, 'FEATURE_NOT_LICENSED') });
      const { fixture, root } = await render();
      toggle(root)!.click();
      await settle(fixture);
      expect(toggle(root)!.checked).toBe(true);
      expect(text(line(root, 'fixes')?.querySelector('[role="alert"]'))).toBe(
        'Automatic fix suggestions need the Enterprise plan.',
      );
    });

    it('sends nothing more while a save is on its way', async () => {
      const server = setup();
      let answer!: () => void;
      server.on(
        'PUT',
        ROUTE,
        () =>
          new Promise((resolve) => {
            answer = () => resolve({ body: { available: true, enabled: false } });
          }),
      );
      const { fixture, root } = await render();
      const fix = toggle(root)!;
      fix.click();
      await settle(fixture);
      expect(fix.getAttribute('aria-disabled')).toBe('true');
      fix.click();
      await settle(fixture);
      expect(fix.checked).toBe(false);
      expect(server.requestsTo('PUT', ROUTE)).toHaveLength(1);
      answer();
      await settle(fixture);
      expect(fix.checked).toBe(false);
      expect(fix.getAttribute('aria-disabled')).toBeNull();
    });

    it('flips back on a refusal that comes after a second move was undone', async () => {
      const server = setup();
      let refuse!: () => void;
      server.on(
        'PUT',
        ROUTE,
        () =>
          new Promise((resolve) => {
            refuse = () =>
              resolve({ status: 409, body: problem(409, 'AUTO_FIX_OPT_OUT_LIMIT_REACHED') });
          }),
      );
      const { fixture, root, saved } = await render();
      const fix = toggle(root)!;
      fix.focus();
      fix.click();
      await settle(fixture);
      // A second move while the first is on its way is undone at once.
      fix.click();
      await settle(fixture);
      expect(fix.checked).toBe(false);
      refuse();
      await settle(fixture);
      expect(server.requestsTo('PUT', ROUTE).map((r) => r.body)).toEqual([{ enabled: false }]);
      expect(fix.checked).toBe(true);
      expect(fix.getAttribute('aria-disabled')).toBeNull();
      expect(text(line(root, 'fixes')?.querySelector('[role="alert"]'))).toBe(
        'This organisation already has 1 000 projects opted out. Switch one back on first.',
      );
      expect(saved).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(fix);
    });

    it('waits for a repository link above a switch that still works', async () => {
      const server = setup();
      FakeAutoFix.install(server);
      const { fixture, root } = await render(
        project({ reason: 'not_mapped', scmConnectionId: null, autoFix: { enabled: false } }),
      );
      const requirement = line(root, 'fixes')!.querySelector('.req')!;
      expect(text(requirement)).toBe(
        'Fix suggestions are posted on merge requests, so they wait until the project is linked to its repository.',
      );
      const fix = toggle(root)!;
      expect(fix.disabled).toBe(false);
      expect(fix.checked).toBe(false);
      expect(fix.getAttribute('aria-describedby')!.split(' ')).toEqual([
        'project-ai-fix-help',
        requirement.id,
      ]);
      fix.click();
      await settle(fixture);
      expect(server.requestsTo('PUT', ROUTE).map((r) => r.body)).toEqual([{ enabled: true }]);
    });

    it('says the organization has them off, with no switch', async () => {
      const server = setup('orgAdmin');
      const { root } = await render(project({ autoFix: { organizationEnabled: false } }));
      expect(toggle(root)).toBeNull();
      const requirement = line(root, 'fixes')!.querySelector('.req')!;
      expect(text(requirement)).toBe(
        'Default has automatic fix suggestions off. An organization admin switches them on in Settings → AI.',
      );
      expect(requirement.querySelector('a')?.getAttribute('href')).toBe('/settings/ai-review');
      expect(server.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
    });

    it('hides the Fixes line in the community edition', async () => {
      setup();
      const { root } = await render(
        project({ autoFix: { available: false, organizationEnabled: false } }),
      );
      expect(line(root, 'fixes')).toBeNull();
      expect(toggle(root)).toBeNull();
      expect(root.textContent).not.toContain('Enterprise');
      expect(line(root, 'review')).not.toBeNull();
      expect(line(root, 'assistant')).not.toBeNull();
    });
  });

  it('says the excluded state on every line', async () => {
    const server = setup();
    const { root } = await render(project({ autoFix: { excludedFromAi: true } }));
    const chip = root.querySelector('.panel-head .sec-chips .badge');
    expect(text(chip)).toBe('Excluded from AI');
    // The chip of an off line: its tone and its icon, never colour alone.
    expect(chip?.classList).toContain('badge-none');
    expect(chip?.querySelector('q-icon svg')).not.toBeNull();
    expect(stateOf(root, 'review')).toEqual({
      state: 'Off',
      sentence: 'An instance admin excluded this project from AI, so nothing of it is sent.',
    });
    expect(stateOf(root, 'assistant')).toEqual({
      state: 'Not available',
      sentence: 'For the same reason: its issues are never sent.',
    });
    expect(stateOf(root, 'fixes')).toEqual({
      state: 'Off',
      sentence: 'Not for a project excluded from AI.',
    });
    expect(toggle(root)).toBeNull();
    expect(root.querySelector('.req, p.hint')).toBeNull();
    expect(server.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });

  describe("the organization's name", () => {
    it('comes from the organizations listed when the session has no membership', async () => {
      setup();
      const signedIn = person('projectAdmin');
      TestBed.inject(SessionStore).set({ ...signedIn, memberships: [] });
      const { root } = await render(project({ reason: 'review_disabled' }));
      expect(stateOf(root, 'review').sentence).toBe(
        'Default has not switched on AI review. An organization admin switches it on in Settings → AI.',
      );
    });

    it('is "The organization" when neither knows it', async () => {
      setup();
      const { root } = await render(
        project({ reason: 'review_disabled', organizationId: 'another-org' }),
      );
      expect(stateOf(root, 'review').sentence).toBe(
        'The organization has not switched on AI review. An organization admin switches it on in Settings → AI.',
      );
    });
  });
});
