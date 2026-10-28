import {
  createEnvironmentInjector,
  EnvironmentInjector,
  runInInjectionContext,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { LeaveConfirm } from './leave-confirm';
import { type LeaveGuarded, LeaveGuards, unsavedChangesGuard, whileDirty } from './unsaved-changes';

describe('unsavedChangesGuard', () => {
  const route = {} as ActivatedRouteSnapshot;
  const state = {} as RouterStateSnapshot;
  const guard = (page: LeaveGuarded) => unsavedChangesGuard(page, route, state, state);

  it('lets a page go, or asks it', async () => {
    expect(guard({ canLeave: () => true })).toBe(true);
    expect(guard({ canLeave: () => false })).toBe(false);
    // A page with unsaved changes asks the person; the navigation waits for the answer.
    let answer: (leave: boolean) => void = (_value) => undefined;
    const asked = new Promise<boolean>((resolve) => (answer = resolve));
    const result = guard({ canLeave: () => asked });
    expect(result).toBe(asked);
    answer(true);
    await expect(result).resolves.toBe(true);
  });

  it('lets a route go whose outlet holds no page', () => {
    // Angular passes null for the component of a route whose outlet was never activated.
    expect(guard(null as unknown as LeaveGuarded)).toBe(true);
  });
});

describe('whileDirty', () => {
  /** Unloads the page as a reload or a closed tab does; true when the browser would ask first. */
  function unload(): boolean {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it('asks before the page unloads while there are unsaved changes, until it is destroyed', () => {
    const dirty = signal(false);
    const injector = createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));
    runInInjectionContext(injector, () => whileDirty(() => dirty()));
    expect(unload()).toBe(false);
    dirty.set(true);
    expect(unload()).toBe(true);
    dirty.set(false);
    expect(unload()).toBe(false);
    dirty.set(true);
    injector.destroy();
    expect(unload()).toBe(false);
  });
});

describe('LeaveGuards', () => {
  it('asks each page with drafts in turn, stops at the first that keeps the person, and forgets a page that went', async () => {
    const guards = TestBed.inject(LeaveGuards);
    const asked: string[] = [];
    const page = (name: string, leave: boolean): LeaveGuarded => ({
      canLeave: () => {
        asked.push(name);
        return Promise.resolve(leave);
      },
    });
    const injector = createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));
    runInInjectionContext(injector, () => {
      guards.register(page('limits', true));
      guards.register(page('data', false));
      guards.register(page('never asked', true));
    });
    expect(await guards.canLeave()).toBe(false);
    expect(asked).toEqual(['limits', 'data']);
    injector.destroy();
    expect(await guards.canLeave()).toBe(true);
    expect(asked).toEqual(['limits', 'data']);
  });

  it('lets go at once while no page keeps drafts', async () => {
    expect(await TestBed.inject(LeaveGuards).canLeave()).toBe(true);
  });
});

describe('LeaveConfirm', () => {
  async function render() {
    const fixture = TestBed.createComponent(LeaveConfirm);
    await fixture.whenStable();
    const dialog = (fixture.nativeElement as HTMLElement).querySelector('dialog')!;
    const button = (name: string) =>
      [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) => text(b) === name)!;
    const question = () =>
      text(dialog.querySelector(`#${dialog.getAttribute('aria-describedby')}`));
    return { fixture, dialog, button, question, confirm: fixture.componentInstance };
  }

  const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();

  it('asks to leave without saving, Stay first', async () => {
    const { fixture, dialog, button, question, confirm } = await render();
    expect(dialog.classList).toContain('dialog');
    expect(dialog.open).toBe(false);

    let answer = confirm.ask(['Limits']);
    await fixture.whenStable();
    expect(dialog.open).toBe(true);
    const title = dialog.querySelector('h2')!;
    expect(text(title)).toBe('Leave without saving?');
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
    expect(question()).toBe('Your changes to Limits are not saved yet.');
    // Stay comes first and takes the focus when the dialog opens (showModal honours autofocus).
    const actions = [...dialog.querySelectorAll('.dialog-actions button')].map((b) => text(b));
    expect(actions).toEqual(['Stay', 'Leave without saving']);
    expect(button('Stay').hasAttribute('autofocus')).toBe(true);
    expect(button('Leave without saving').hasAttribute('autofocus')).toBe(false);
    button('Stay').click();
    await expect(answer).resolves.toBe(false);
    await fixture.whenStable();
    expect(dialog.open).toBe(false);

    answer = confirm.ask(['Limits', 'Data and privacy']);
    await fixture.whenStable();
    expect(question()).toBe('Your changes to Limits and Data and privacy are not saved yet.');
    button('Leave without saving').click();
    await expect(answer).resolves.toBe(true);
    await fixture.whenStable();
    expect(dialog.open).toBe(false);

    answer = confirm.ask(['Limits']);
    await fixture.whenStable();
    expect(dialog.open).toBe(true);
    // Escape closes the dialog through its close event: the person stays.
    dialog.dispatchEvent(new Event('close'));
    await expect(answer).resolves.toBe(false);
  });

  it('answers an earlier question with Stay when it asks again, and keeps asking', async () => {
    const { fixture, dialog, button, question, confirm } = await render();
    // As a browser's dialog: close() fires the close event later, as a task of its own.
    Object.assign(dialog, {
      showModal: () => dialog.setAttribute('open', ''),
      close: () => {
        dialog.removeAttribute('open');
        setTimeout(() => dialog.dispatchEvent(new Event('close')));
      },
    });
    const first = confirm.ask(['Limits']);
    await fixture.whenStable();
    expect(dialog.open).toBe(true);
    // Back pressed while it asks: a second navigation asks again.
    const second = confirm.ask(['Provider']);
    await expect(first).resolves.toBe(false);
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve));
    expect(dialog.open).toBe(true);
    expect(question()).toBe('Your changes to Provider are not saved yet.');
    button('Leave without saving').click();
    await expect(second).resolves.toBe(true);
  });
});
