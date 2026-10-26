import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Me } from '../api/types';
import { SessionStore } from '../auth/session';
import {
  FakeServer,
  me,
  ORG_ADMIN_PERMISSIONS,
  ORG_ID,
  page,
  provideFakeServer,
  settle,
} from '../../testing/fake-server';
import { OrgContext } from '../org/org-context';
import { type RequirementPlace, Requirement } from './requirement';

const OTHER_ORG = '0190a6c2-0000-7000-8000-000000000002';

const NEEDS_FIX = 'Needs Suggest a fix for Acme, which an instance admin turns on in';

/** An organisation admin of Acme who is no instance admin. */
function orgAdmin(): Me {
  const admin = me({ admin: true });
  return { ...admin, user: { ...admin.user, isInstanceAdmin: false } };
}

describe('Requirement', () => {
  function signIn(who: Me): void {
    const server = new FakeServer();
    server.on('GET', '/api/v0/organizations', {
      body: page([
        { id: ORG_ID, key: 'acme', name: 'Acme', createdAt: '', updatedAt: '' },
        { id: OTHER_ORG, key: 'research', name: 'Research', createdAt: '', updatedAt: '' },
      ]),
    });
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideFakeServer(server)] });
    TestBed.inject(SessionStore).set(who);
  }

  async function render(
    place: RequirementPlace | null,
    words = NEEDS_FIX,
    organizationId: string | null = null,
  ) {
    const fixture = TestBed.createComponent(Requirement);
    fixture.componentRef.setInput('noteId', 'note');
    fixture.componentRef.setInput('text', words);
    fixture.componentRef.setInput('place', place);
    if (organizationId !== null) fixture.componentRef.setInput('organizationId', organizationId);
    await settle(fixture);
    return { fixture, note: (fixture.nativeElement as HTMLElement).querySelector('p#note')! };
  }

  const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();

  it('links the place for someone who can open it', async () => {
    signIn(me({ admin: true }));
    const { note } = await render('ai-provider');
    expect(note.classList).toContain('req');
    expect(note.querySelector('q-icon svg')).not.toBeNull();
    expect(text(note)).toBe(
      'Needs Suggest a fix for Acme, which an instance admin turns on in Settings → AI provider.',
    );
    const link = note.querySelector('a[href="/settings/ai"]');
    expect(text(link)).toBe('Settings → AI provider');
  });

  it('links each place an organisation admin can open to its page', async () => {
    signIn(orgAdmin());
    const places = [
      ['org-ai', '/settings/ai-review', 'Settings → AI'],
      ['repositories', '/settings/repositories', 'Settings → Repositories'],
      ['gitlab', '/settings/gitlab', 'Settings → GitLab'],
      ['github', '/settings/github', 'Settings → GitHub'],
    ] as const;
    for (const [place, route, name] of places) {
      const { fixture, note } = await render(place, 'An organization admin changes it in');
      expect(text(note.querySelector(`a[href="${route}"]`)), place).toBe(name);
      expect(text(note), place).toBe(`An organization admin changes it in ${name}.`);
      fixture.destroy();
    }
  });

  it('names the place without a link for someone who cannot', async () => {
    signIn(orgAdmin());
    const { note } = await render('ai-provider');
    expect(note.querySelector('a')).toBeNull();
    expect(text(note)).toBe(
      'Needs Suggest a fix for Acme, which an instance admin turns on in Settings → AI provider.',
    );
  });

  it('names an organisation place without a link for a member', async () => {
    signIn(me());
    for (const place of ['org-ai', 'repositories', 'gitlab', 'github'] as const) {
      const { fixture, note } = await render(place, 'An organization admin changes it in');
      expect(note.querySelector('a'), place).toBeNull();
      expect(text(note), place).toMatch(/^An organization admin changes it in Settings → \w+\.$/);
      fixture.destroy();
    }
  });

  describe('for a setting of a named organization', () => {
    /** An admin of both organizations who is no instance admin; the header shows `current`. */
    async function adminOfBoth(current: string): Promise<void> {
      const admin = orgAdmin();
      signIn({
        ...admin,
        memberships: [
          admin.memberships[0]!,
          {
            ...admin.memberships[0]!,
            organizationId: OTHER_ORG,
            organizationKey: 'research',
            organizationName: 'Research',
            permissions: [...ORG_ADMIN_PERMISSIONS],
          },
        ],
      });
      const org = TestBed.inject(OrgContext);
      org.select(current);
      onTestFinished(() => localStorage.removeItem('qualor.organizationId'));
      await settle();
      expect(org.currentId()).toBe(current);
    }

    it('links the place while the header shows that organization', async () => {
      await adminOfBoth(ORG_ID);
      const { note } = await render('org-ai', 'An organization admin changes it in', ORG_ID);
      expect(text(note.querySelector('a[href="/settings/ai-review"]'))).toBe('Settings → AI');
    });

    it("names the place only while the header shows another organization: the link would open that one's page", async () => {
      await adminOfBoth(OTHER_ORG);
      for (const place of ['org-ai', 'repositories', 'gitlab', 'github'] as const) {
        const { fixture, note } = await render(
          place,
          'An organization admin changes it in',
          ORG_ID,
        );
        expect(note.querySelector('a'), place).toBeNull();
        expect(text(note), place).toMatch(/^An organization admin changes it in Settings → \w+\.$/);
        fixture.destroy();
      }
    });

    it('links the AI provider for an instance admin whatever the header shows', async () => {
      signIn(me({ admin: true }));
      TestBed.inject(OrgContext).select(ORG_ID);
      onTestFinished(() => localStorage.removeItem('qualor.organizationId'));
      const { note } = await render('ai-provider', NEEDS_FIX, OTHER_ORG);
      expect(note.querySelector('a[href="/settings/ai"]')).not.toBeNull();
    });
  });

  it('says a requirement without a place as it is given', async () => {
    signIn(me({ admin: true }));
    const words =
      'Fix suggestions are posted on merge requests, so they wait until the project is linked to its repository.';
    const { note } = await render(null, words);
    expect(text(note)).toBe(words);
    expect(note.querySelector('a')).toBeNull();
  });
});
