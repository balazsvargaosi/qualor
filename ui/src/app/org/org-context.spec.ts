import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FakeServer, me, ORG_ID, page, provideFakeServer, settle } from '../../testing/fake-server';
import { SessionStore } from '../auth/session';
import { type LeaveGuarded, LeaveGuards } from '../shared/unsaved-changes';
import { OrgContext } from './org-context';

const org = (id: string, name: string) => ({ id, key: id, name, createdAt: '', updatedAt: '' });

describe('OrgContext', () => {
  afterEach(() => localStorage.clear());

  it('reads every page of the list and selects the organisation chosen earlier on page 2', async () => {
    localStorage.setItem('qualor.organizationId', 'org-late');
    const server = new FakeServer();
    server.on('GET', '/api/v0/organizations', (request) =>
      request.query.get('cursor') === 'c1'
        ? { body: page([org('org-late', 'Late')]) }
        : { body: page([org(ORG_ID, 'Default')], 'c1') },
    );
    TestBed.configureTestingModule({ providers: [provideFakeServer(server)] });
    TestBed.inject(SessionStore).set(me());
    const context = TestBed.inject(OrgContext);
    context.orgs();
    await settle(TestBed.inject(ApplicationRef));

    expect(server.requestsTo('GET', '/api/v0/organizations')).toHaveLength(2);
    expect(context.orgs().map((o) => o.id)).toEqual([ORG_ID, 'org-late']);
    expect(context.currentId()).toBe('org-late');
    expect(context.current()?.name).toBe('Late');
  });

  it('switches only once every page with unsaved changes lets go of them', async () => {
    const server = new FakeServer();
    server.on('GET', '/api/v0/organizations', {
      body: page([org(ORG_ID, 'Default'), org('org-2', 'Acme')]),
    });
    TestBed.configureTestingModule({ providers: [provideFakeServer(server)] });
    TestBed.inject(SessionStore).set(me());
    const context = TestBed.inject(OrgContext);
    context.orgs();
    await settle(TestBed.inject(ApplicationRef));
    // A page with unsaved changes asks the person (q-leave-confirm); the switch waits for it.
    let answer: (leave: boolean) => void = () => undefined;
    let asked = 0;
    const guarded: LeaveGuarded = {
      canLeave: () => {
        asked++;
        return new Promise<boolean>((resolve) => (answer = resolve));
      },
    };
    TestBed.runInInjectionContext(() => TestBed.inject(LeaveGuards).register(guarded));

    let switching = context.switchTo('org-2');
    answer(false);
    expect(await switching).toBe(false);
    expect(context.currentId()).toBe(ORG_ID);

    switching = context.switchTo('org-2');
    answer(true);
    expect(await switching).toBe(true);
    expect(context.currentId()).toBe('org-2');
    expect(asked).toBe(2);
    // The organisation already in use: nothing to ask.
    expect(await context.switchTo('org-2')).toBe(true);
    expect(asked).toBe(2);
  });
});
