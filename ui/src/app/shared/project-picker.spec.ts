import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { ItemOf } from '../api/types';
import { SessionStore } from '../auth/session';
import {
  FakeServer,
  type FakeReply,
  me,
  ORG_ID,
  page,
  provideFakeServer,
} from '../../testing/fake-server';
import { type PickedProject, ProjectPicker } from './project-picker';
import { SEARCH_DELAY_MS } from './user-picker';

type Project = ItemOf<'/api/v0/projects'>;

/** A project of the organisation as the list carries it (only what the picker reads). */
function project(id: string, key: string, name: string, excludedFromAi = false): Project {
  return { id, organizationId: ORG_ID, key, name, autoFix: { excludedFromAi } } as Project;
}

const PAYMENTS = project('p-payments', 'acme/payments', 'Payments core');
const SHOP = project('p-shop', 'acme/web-shop', 'Web shop');
const LEGACY = project('p-legacy', 'acme/legacy-billing', 'Legacy billing', true);
const PROJECTS = [PAYMENTS, SHOP, LEGACY];
const LIST = '/api/v0/projects';

describe('ProjectPicker', () => {
  let server: FakeServer;
  let fixture: ComponentFixture<ProjectPicker>;

  beforeEach(() => {
    // Only the timers: Angular's scheduling and the promises still run, the debounce waits.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = new FakeServer();
    server.on('GET', LIST, (r) => {
      const q = r.query.get('q')?.toLowerCase() ?? '';
      return {
        body: page(PROJECTS.filter((p) => p.name.toLowerCase().includes(q) || p.key.includes(q))),
      };
    });
    TestBed.configureTestingModule({ providers: [provideRouter([]), provideFakeServer(server)] });
    TestBed.inject(SessionStore).set(me({ admin: true }));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Runs the timers due in `ms`, then lets the fake server answer and the view render. */
  async function flush(ms = 0): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(0);
      fixture.detectChanges();
    }
  }

  async function render(
    options: { chosen?: string[]; unavailable?: (p: Project) => string | null } = {},
  ) {
    fixture = TestBed.createComponent(ProjectPicker);
    fixture.componentRef.setInput('organizationId', ORG_ID);
    fixture.componentRef.setInput('buttonLabel', 'Add projects');
    fixture.componentRef.setInput('chosen', options.chosen ?? []);
    if (options.unavailable) fixture.componentRef.setInput('unavailable', options.unavailable);
    await flush();
    const root = fixture.nativeElement as HTMLElement;
    const added: PickedProject[][] = [];
    fixture.componentInstance.add.subscribe((picked) => added.push(picked));
    const toggle = () => root.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    const panel = () =>
      root.querySelector<HTMLElement>(`#${toggle().getAttribute('aria-controls')}`)!;
    const search = () => panel().querySelector<HTMLInputElement>('input[type="search"]')!;
    const button = (name: string) =>
      [...panel().querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => text(b) === name || text(b)?.startsWith(`${name} `),
      )!;
    return { root, added, toggle, panel, search, button };
  }

  const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();

  function options(panel: HTMLElement): string[] {
    return [...panel.querySelectorAll('li label')].map((l) => text(l) ?? '');
  }

  function box(panel: HTMLElement, name: string): HTMLInputElement {
    const label = [...panel.querySelectorAll('li label')].find((l) => text(l)?.startsWith(name));
    return label!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  }

  function type(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  function press(target: HTMLElement, key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    fixture.detectChanges();
    return event;
  }

  it('searches the organisation’s projects on the server as one types, 20 at most', async () => {
    const { toggle, panel, search } = await render();
    expect(toggle().classList).toContain('btn');
    expect(text(toggle())).toBe('Add projects');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(panel().hidden).toBe(true);
    expect(server.requestsTo('GET', LIST)).toHaveLength(0);

    toggle().click();
    await flush();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(panel().hidden).toBe(false);
    // In place under its button, a group named by it.
    expect(panel().getAttribute('role')).toBe('group');
    expect(panel().getAttribute('aria-labelledby')).toBe(toggle().id);
    expect(document.activeElement).toBe(search());
    expect(text(search().labels?.[0])).toBe('Filter projects');
    const opened = server.requestsTo('GET', LIST);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.query.get('organizationId')).toBe(ORG_ID);
    expect(opened[0]!.query.get('limit')).toBe('20');
    expect(opened[0]!.query.has('q')).toBe(false);
    expect(options(panel())).toEqual([
      'Payments core acme/payments',
      'Web shop acme/web-shop',
      'Legacy billing acme/legacy-billing',
    ]);
    // The key in mono.
    expect(panel().querySelector('li label code')?.textContent).toBe('acme/payments');
    // A screen reader hears how many it found.
    const live = panel().querySelector('[aria-live="polite"]')!;
    expect(text(live)).toBe('3 projects found');
    expect(live.querySelector('.visually-hidden')).not.toBeNull();

    type(search(), 'we');
    await flush(100);
    type(search(), 'web');
    await flush(SEARCH_DELAY_MS - 1);
    expect(server.requestsTo('GET', LIST)).toHaveLength(1);
    await flush(1);
    const searched = server.requestsTo('GET', LIST);
    expect(searched).toHaveLength(2);
    expect(searched[1]!.query.get('organizationId')).toBe(ORG_ID);
    expect(searched[1]!.query.get('q')).toBe('web');
    expect(searched[1]!.query.get('limit')).toBe('20');
    expect(options(panel())).toEqual(['Web shop acme/web-shop']);
    expect(text(live)).toBe('1 project found');

    type(search(), 'zzz');
    await flush(SEARCH_DELAY_MS);
    expect(options(panel())).toEqual([]);
    expect(text(panel().querySelector('[aria-live="polite"]'))).toBe('No project matches.');
  });

  it('shows only the answer to the latest search, whatever order they arrive in', async () => {
    const held: { q: string | null; reply: (r: FakeReply) => void }[] = [];
    server.on(
      'GET',
      LIST,
      (r) => new Promise<FakeReply>((reply) => held.push({ q: r.query.get('q'), reply })),
    );
    const { toggle, panel, search } = await render();
    toggle().click();
    await flush();
    expect(text(panel().querySelector('[aria-live="polite"]'))).toBe('Searching…');
    type(search(), 'pay');
    await flush(SEARCH_DELAY_MS);
    expect(held.map((h) => h.q)).toEqual([null, 'pay']);
    held[1]!.reply({ body: page([PAYMENTS]) });
    await flush();
    expect(options(panel())).toEqual(['Payments core acme/payments']);
    // The first, broader answer arrives late: it is dropped.
    held[0]!.reply({ body: page(PROJECTS) });
    await flush();
    expect(options(panel())).toEqual(['Payments core acme/payments']);
    expect(text(panel().querySelector('[aria-live="polite"]'))).toBe('1 project found');
  });

  it('offers a project already in the list ticked and disabled', async () => {
    const { toggle, panel } = await render({ chosen: [PAYMENTS.id] });
    toggle().click();
    await flush();
    const payments = box(panel(), 'Payments core');
    expect(payments.checked).toBe(true);
    expect(payments.disabled).toBe(true);
    expect(text(payments.closest('label'))).toBe('Payments core acme/payments Already in the list');
    expect(box(panel(), 'Web shop').disabled).toBe(false);
    expect(box(panel(), 'Web shop').checked).toBe(false);
  });

  it('disables a project with the reason it cannot be added', async () => {
    const { toggle, panel } = await render({
      unavailable: (p) =>
        p.autoFix.excludedFromAi ? 'Excluded from AI by an instance admin' : null,
    });
    toggle().click();
    await flush();
    const legacy = box(panel(), 'Legacy billing');
    expect(legacy.disabled).toBe(true);
    expect(legacy.checked).toBe(false);
    expect(text(legacy.closest('label'))).toBe(
      'Legacy billing acme/legacy-billing Excluded from AI by an instance admin',
    );
    expect(box(panel(), 'Payments core').disabled).toBe(false);
  });

  it('adds the ticked projects, closes and gives focus back to its button', async () => {
    const { added, toggle, panel, button } = await render();
    toggle().click();
    await flush();
    const add = button('Add');
    expect(text(add)).toBe('Add');
    expect(add.disabled).toBe(true);
    box(panel(), 'Payments core').click();
    await flush();
    expect(text(add)).toBe('Add 1 project');
    box(panel(), 'Web shop').click();
    await flush();
    expect(text(add)).toBe('Add 2 projects');
    expect(add.disabled).toBe(false);
    add.click();
    await flush();
    expect(added).toEqual([
      [
        { id: PAYMENTS.id, name: 'Payments core', key: 'acme/payments' },
        { id: SHOP.id, name: 'Web shop', key: 'acme/web-shop' },
      ],
    ]);
    expect(panel().hidden).toBe(true);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle());
  });

  it('keeps what was ticked while the search changes', async () => {
    const { added, toggle, panel, search, button } = await render();
    toggle().click();
    await flush();
    box(panel(), 'Payments core').click();
    type(search(), 'web');
    await flush(SEARCH_DELAY_MS);
    box(panel(), 'Web shop').click();
    await flush();
    button('Add').click();
    await flush();
    expect(added[0]!.map((p) => p.id)).toEqual([PAYMENTS.id, SHOP.id]);
  });

  it('closes on Escape without adding', async () => {
    const { added, toggle, panel, search, button } = await render();
    toggle().click();
    await flush();
    box(panel(), 'Payments core').click();
    type(search(), 'pay');
    await flush(SEARCH_DELAY_MS);
    const escape = press(search(), 'Escape');
    await flush();
    expect(escape.defaultPrevented).toBe(true);
    expect(panel().hidden).toBe(true);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle());
    expect(added).toEqual([]);

    // Opened again, it starts afresh: nothing ticked, an empty search.
    toggle().click();
    await flush();
    expect(search().value).toBe('');
    expect(box(panel(), 'Payments core').checked).toBe(false);

    // Cancel closes it the same way.
    box(panel(), 'Web shop').click();
    button('Cancel').click();
    await flush();
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(toggle());
    expect(added).toEqual([]);

    // Closed, Escape is left to what is around it (a dialog).
    expect(press(toggle(), 'Escape').defaultPrevented).toBe(false);
  });
});
