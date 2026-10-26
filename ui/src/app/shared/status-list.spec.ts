import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ICONS } from './icons';
import { type StatusLine, StatusList, TONE_CHIPS } from './status-list';

const LINES: readonly StatusLine[] = [
  {
    key: 'provider',
    label: 'Provider',
    tone: 'ok',
    state: 'Connected',
    text: 'OpenAI-compatible at api.openai.com · 3 models',
    sub: 'Tested today: all three connect and can call tools.',
    action: { id: 'test', label: 'Test again' },
  },
  {
    key: 'organizations',
    label: 'Organizations',
    tone: 'off',
    state: 'None may use AI',
    action: { id: 'manage', label: 'Manage', link: '/settings/ai', fragment: 'organizations' },
  },
  {
    key: 'review',
    label: 'AI review',
    tone: 'attention',
    state: 'Paused in Acme',
    tags: ['Enterprise'],
    action: {
      id: 'confirm',
      label: 'Review and confirm…',
      primary: true,
      ariaLabel: 'Review and confirm the AI provider of Acme…',
    },
  },
  { key: 'test', label: 'Last test', tone: 'broken', state: 'Test failed' },
];

describe('StatusList', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
  });

  async function render(lines: readonly StatusLine[] = LINES) {
    const fixture = TestBed.createComponent(StatusList);
    fixture.componentRef.setInput('lines', lines);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const line = (key: string) => root.querySelector<HTMLElement>(`li[data-key="${key}"]`)!;
    return { fixture, root, line, list: fixture.componentInstance };
  }

  const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();

  /** The name of the icon drawn in `el`, by its first path. */
  function iconOf(el: Element): string | undefined {
    const d = el.querySelector('q-icon path')?.getAttribute('d');
    return Object.entries(ICONS).find(([, icon]) => icon.d[0] === d)?.[0];
  }

  it('draws each tone as its badge, icon and words', async () => {
    const { line } = await render();
    const expected = [
      ['provider', 'badge-passed', 'check', 'Connected'],
      ['organizations', 'badge-none', 'minus', 'None may use AI'],
      ['review', 'badge-warn', 'alert', 'Paused in Acme'],
      ['test', 'badge-failed', 'cross', 'Test failed'],
    ] as const;
    for (const [key, badgeClass, icon, state] of expected) {
      const chip = line(key).querySelector('.badge')!;
      expect(chip.classList, key).toContain(badgeClass);
      expect(iconOf(chip), key).toBe(icon);
      expect(text(chip), key).toBe(state);
    }
    // Its label, its sentence and its muted sub, and the tags after the chip.
    expect(text(line('provider').querySelector('.st-label'))).toBe('Provider');
    expect(text(line('provider').querySelector('.st-line'))).toBe(
      'Connected OpenAI-compatible at api.openai.com · 3 models',
    );
    expect(text(line('provider').querySelector('.st-sub'))).toBe(
      'Tested today: all three connect and can call tools.',
    );
    const tag = line('review').querySelector('.badge.badge-tag')!;
    expect(text(tag)).toBe('Enterprise');
    expect(line('review').querySelector('.badge')).not.toBe(tag);
    expect(line('test').querySelector('.st-sub')).toBeNull();
  });

  it("shares each tone's chip, so a section's head says a state as its line does", () => {
    expect(TONE_CHIPS).toEqual({
      ok: { badge: 'badge-passed', icon: 'check' },
      off: { badge: 'badge-none', icon: 'minus' },
      attention: { badge: 'badge-warn', icon: 'alert' },
      broken: { badge: 'badge-failed', icon: 'cross' },
    });
  });

  it('emits the action of a line; a link action is a link', async () => {
    const { fixture, root, line, list } = await render();
    const acts: string[] = [];
    list.act.subscribe((id) => acts.push(id));

    const test = line('provider').querySelector<HTMLButtonElement>('.st-act button')!;
    expect(test.type).toBe('button');
    expect(test.classList).toContain('btn');
    expect(test.classList).not.toContain('btn-primary');
    expect(text(test)).toBe('Test again');
    test.click();
    await fixture.whenStable();
    expect(acts).toEqual(['test']);

    const manage = root.querySelector<HTMLAnchorElement>('a[href="/settings/ai#organizations"]')!;
    expect(manage).not.toBeNull();
    expect(manage.classList).toContain('btn');
    expect(text(manage)).toBe('Manage');
    expect(line('organizations').querySelector('.st-act button')).toBeNull();

    const confirm = line('review').querySelector<HTMLButtonElement>('.st-act button')!;
    expect(confirm.classList).toContain('btn-primary');
    expect(confirm.getAttribute('aria-label')).toBe('Review and confirm the AI provider of Acme…');
    confirm.click();
    await fixture.whenStable();
    expect(acts).toEqual(['test', 'confirm']);

    expect(line('test').querySelector('.st-act a, .st-act button')).toBeNull();
  });

  it('draws the meters of a line', async () => {
    const { line } = await render([
      {
        key: 'today',
        label: 'Today',
        tone: 'ok',
        state: '',
        meters: [
          { label: 'AI review', value: 120_000, max: 1_000_000, note: '3 reviews · $1.23' },
          { label: 'Cost', value: 1.23, max: 20, unit: 'usd' },
        ],
      },
    ]);
    const meters = line('today').querySelectorAll('q-meter');
    expect(meters).toHaveLength(2);
    expect(text(meters[0]!.querySelector('.meter-label'))).toBe('AI review');
    expect(text(meters[0]!.querySelector('.meter-value'))).toBe('120,000 of 1,000,000');
    expect(text(meters[0]!.querySelector('.meter-note'))).toBe('3 reviews · $1.23');
    expect(text(meters[1]!.querySelector('.meter-value'))).toBe('$1.23 of $20.00');
    // A line of meters alone has no state, so no chip.
    expect(line('today').querySelector('.badge')).toBeNull();
  });

  it('draws no label for a line without one, and keeps its text in the text column', async () => {
    const { line } = await render([
      ...LINES.slice(0, 1),
      { key: 'community', label: '', tone: 'off', state: '', sub: 'Part of Qualor Enterprise.' },
    ]);
    const community = line('community');
    expect(community.querySelector('.st-label')).toBeNull();
    expect(text(community)).toBe('Part of Qualor Enterprise.');
    // Beside the lines with a label, its sentence starts where theirs do.
    expect(getComputedStyle(community.querySelector('.st-text')!).gridColumn).toBe('2');
    expect(text(line('provider').querySelector('.st-label'))).toBe('Provider');
  });

  it('lets a long name in a state wrap instead of widening the page', async () => {
    // An organisation's name has up to 255 characters, and may have no break point.
    const name = 'A'.repeat(255);
    const { root, line } = await render([
      { key: 'review', label: 'AI review', tone: 'ok', state: `On in ${name}` },
    ]);
    const chip = line('review').querySelector<HTMLElement>('.badge')!;
    expect(text(chip)).toBe(`On in ${name}`);
    expect(getComputedStyle(chip).whiteSpace).toBe('normal');
    expect(getComputedStyle(chip).maxWidth).toBe('100%');
    // It breaks anywhere, as all of the line's text does.
    expect(getComputedStyle(root.querySelector('.st-text')!).overflowWrap).toBe('anywhere');
  });

  it('is a list under a heading named Status', async () => {
    const { root } = await render();
    const section = root.querySelector('section[aria-labelledby]')!;
    expect(section.classList).toContain('card');
    const heading = root.querySelector(`#${section.getAttribute('aria-labelledby')}`)!;
    expect(heading.tagName).toBe('H3');
    expect(text(heading)).toBe('Status');
    const items = section.querySelectorAll('ul.status-list > li[data-key]');
    expect([...items].map((li) => li.getAttribute('data-key'))).toEqual([
      'provider',
      'organizations',
      'review',
      'test',
    ]);
  });
});
