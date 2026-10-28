import { noAnswerYet } from '../../../testing/pending';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CONFIGURED, type } from '../../../testing/ai-settings';
import {
  type FakeReply,
  FakeServer,
  me,
  problem,
  provideFakeServer,
  settle,
} from '../../../testing/fake-server';
import { Api, ok } from '../../api/api';
import { SessionStore } from '../../auth/session';
import { bodyFrom, type LlmBody, type LlmSettings } from './llm-body';
import { LimitsSection, type SaveLimits } from './limits-section';

type Budgets = LlmBody['budgets'];
type Fixture = { whenStable(): Promise<unknown> };

const PRICES = { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2, strong: null, fast: null };
const WITH_CEILING = {
  ...CONFIGURED,
  budgets: { ...CONFIGURED.budgets, reviewTokensPerOrganizationPerDay: 750_000 },
};
const WITH_PRICES = { ...CONFIGURED, pricing: PRICES };

/** The settings the server holds: what the section was given, then what each save stored. */
let stored: LlmSettings;

function setup(reply?: (budgets: Budgets) => FakeReply): FakeServer {
  const server = new FakeServer();
  server.on('PUT', '/api/v0/system/llm', (request) => {
    const budgets = (request.body as LlmBody).budgets;
    return reply?.(budgets) ?? { body: { ...stored, budgets } };
  });
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: '**', children: [] }]), provideFakeServer(server)],
  });
  TestBed.inject(SessionStore).set(me({ admin: true }));
  return server;
}

/**
 * The section with the settings given. Its save does what the page does: the stored settings with
 * the section's budgets go to the server, whose answer becomes the section's settings.
 */
async function render(given: { settings?: object; saveLimits?: SaveLimits } = {}) {
  const fixture = TestBed.createComponent(LimitsSection);
  stored = (given.settings ?? CONFIGURED) as LlmSettings;
  const api = TestBed.inject(Api);
  const saveLimits: SaveLimits =
    given.saveLimits ??
    (async (budgets) => {
      const body = bodyFrom(stored, { section: 'limits', budgets });
      const saved = await ok(api.client.PUT('/api/v0/system/llm', { body }));
      stored = saved;
      fixture.componentRef.setInput('settings', saved);
      return saved;
    });
  fixture.componentRef.setInput('settings', stored);
  fixture.componentRef.setInput('saveLimits', saveLimits);
  await settle(fixture);
  return {
    fixture,
    root: fixture.nativeElement as HTMLElement,
    section: fixture.componentInstance,
  };
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();
const field = (root: HTMLElement, id: string) => root.querySelector<HTMLInputElement>(`#${id}`)!;
const labelOf = (root: HTMLElement, id: string) => text(root.querySelector(`label[for="${id}"]`));
const foot = (root: HTMLElement) => text(root.querySelector('.foot-status'));
const errorOf = (root: HTMLElement, id: string) => text(root.querySelector(`#${id}-error`));
const puts = (server: FakeServer) =>
  server.requestsTo('PUT', '/api/v0/system/llm').map((r) => (r.body as LlmBody).budgets);
/** The ids an input's `aria-describedby` names, and their text. */
const described = (root: HTMLElement, id: string) =>
  (field(root, id).getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter((ref) => ref !== '')
    .map((ref) => text(root.querySelector(`#${ref}`)));

async function fill(fixture: Fixture, root: HTMLElement, id: string, value: string) {
  type(root, `#${id}`, value);
  await settle(fixture);
}
async function click(fixture: Fixture, target: HTMLElement | null | undefined) {
  target!.click();
  await settle(fixture);
}
const saveButton = (root: HTMLElement) =>
  [...root.querySelectorAll('button')].find((b) => text(b) === 'Save limits')!;
const save = (fixture: Fixture, root: HTMLElement) => click(fixture, saveButton(root));

describe('LimitsSection: the fields', () => {
  it('shows the stored limits in fields named for what they count, with their units', async () => {
    setup();
    const { root, section } = await render();
    expect(section.dirtyLabel).toBe('Limits');
    expect(text(root.querySelector('#ai-limits-heading'))).toBe('Limits');
    expect(text(root.querySelector('.sec-purpose'))).toBe(
      'What each allowed organization may spend per UTC day.',
    );
    expect(text(root.querySelector('.sec-chips'))).toBe('Set');
    expect(text(root.querySelector('#ai-limits-assistant'))).toBe(
      'Explain, Suggest triage and Suggest a fix',
    );
    expect(text(root.querySelector('#ai-limits-assistant + .hint'))).toBe(
      'The same for each allowed organization. Automatic fix suggestions count as fix suggestions.',
    );
    const fields = [
      ['ai-budget-explain', 'Explanations per day', '200'],
      ['ai-budget-triage', 'Triage suggestions per day', '100'],
      ['ai-budget-fix', 'Fix suggestions per day', '25'],
      ['ai-budget-tokens', 'Tokens per day', '1,000,000'],
      ['ai-budget-user', 'Asks per person and hour', '30'],
    ];
    for (const [id, label, value] of fields) {
      expect(labelOf(root, id!), id).toBe(label);
      expect(field(root, id!).value, id).toBe(value);
      // Text fields: nothing changes on the mouse wheel.
      expect(field(root, id!).type, id).toBe('text');
      expect(field(root, id!).inputMode, id).toBe('numeric');
    }
    expect(described(root, 'ai-budget-tokens')).toEqual(['tokens']);
    expect(described(root, 'ai-budget-user')).toEqual(['The three features together.']);
    // No edition ceiling on the fix suggestions (D10): no note beside the field.
    expect(root.textContent).not.toMatch(/at most 25/i);
    expect(described(root, 'ai-budget-fix')).toEqual([]);
    // The optional limits are off: their fields are not there.
    expect(field(root, 'ai-budget-cost-set').checked).toBe(false);
    expect(field(root, 'ai-budget-review-set').checked).toBe(false);
    expect(root.querySelector('#ai-budget-cost')).toBeNull();
    expect(root.querySelector('#ai-budget-review')).toBeNull();
    expect(foot(root)).toBe('No unsaved changes');
    expect(saveButton(root).getAttribute('aria-disabled')).toBe('true');
  });

  it('names each switch by its name, and describes it by its help and the note shown with it', async () => {
    setup();
    const { root } = await render();
    for (const [id, name, help] of [
      ['ai-budget-cost-set', 'Limit the cost', 'Off: no cost limit. On: an amount in US$ per day.'],
      [
        'ai-budget-review-set',
        'Cap the tokens an organization may give AI review',
        'Off: no cap, and organization admins may allow up to 1,000,000,000 tokens a day.',
      ],
    ]) {
      const input = field(root, id!);
      expect(input.getAttribute('role'), id).toBe('switch');
      expect(text(root.querySelector(`#${input.getAttribute('aria-labelledby')}`)), id).toBe(name);
      expect(described(root, id!)[0], id).toBe(help);
    }
    // Without prices, the requirement is read with the cost switch.
    expect(described(root, 'ai-budget-cost-set')).toEqual([
      'Off: no cost limit. On: an amount in US$ per day.',
      'No prices are set, so a cost limit would count nothing. Enter them under Provider → Prices.',
    ]);
  });

  it('takes a fix budget up to 100 000 and refuses more on its field, sending nothing (D10)', async () => {
    const server = setup();
    const { fixture, root } = await render();
    await fill(fixture, root, 'ai-budget-fix', '100000');
    expect(foot(root)).toBe('1 unsaved change');
    await save(fixture, root);
    expect(puts(server)).toEqual([{ ...CONFIGURED.budgets, fixPerDay: 100_000 }]);
    expect(field(root, 'ai-budget-fix').value).toBe('100,000');
    expect(foot(root)).toMatch(/^Saved at \d{1,2}:\d{2} [AP]M UTC\.$/);

    await fill(fixture, root, 'ai-budget-fix', '100001');
    await save(fixture, root);
    expect(puts(server)).toHaveLength(1);
    expect(field(root, 'ai-budget-fix').getAttribute('aria-invalid')).toBe('true');
    expect(errorOf(root, 'ai-budget-fix')).toBe('Use a whole number, 0 or more.');
    expect(described(root, 'ai-budget-fix')).toEqual(['Use a whole number, 0 or more.']);
    expect(foot(root)).toBe('1 field needs attention: Fix suggestions per day');
    expect(document.activeElement).toBe(field(root, 'ai-budget-fix'));
    // Typing again clears it.
    await fill(fixture, root, 'ai-budget-fix', '99');
    expect(root.querySelector('#ai-budget-fix-error')).toBeNull();
    expect(foot(root)).toBe('1 unsaved change');
  });

  it('refuses what is not a whole number in its bounds, each field in the page’s words', async () => {
    const server = setup();
    const { fixture, root } = await render();
    const refused: [string, string, string][] = [
      ['ai-budget-explain', '-1', 'Use a whole number, 0 or more.'],
      ['ai-budget-triage', '1.5', 'Use a whole number, 0 or more.'],
      ['ai-budget-tokens', '1,000,000,001', 'Use a whole number, 0 or more.'],
      ['ai-budget-user', '0', 'Use a whole number, 1 or more.'],
    ];
    for (const [id, value] of refused) await fill(fixture, root, id, value);
    await fill(fixture, root, 'ai-budget-fix', '');
    await save(fixture, root);
    expect(puts(server)).toEqual([]);
    for (const [id, , message] of refused) expect(errorOf(root, id), id).toBe(message);
    expect(errorOf(root, 'ai-budget-fix')).toBe('Use a whole number, 0 or more.');
    expect(foot(root)).toBe(
      '5 fields need attention: Explanations per day, Triage suggestions per day, Fix suggestions per day, Tokens per day, and Asks per person and hour',
    );
    // The first in the section's order takes the focus.
    expect(document.activeElement).toBe(field(root, 'ai-budget-explain'));

    for (const [id, value] of [
      ['ai-budget-explain', '0'],
      ['ai-budget-triage', '100,000'],
      ['ai-budget-fix', '0'],
      ['ai-budget-tokens', '1 000 000 000'],
      ['ai-budget-user', '10000'],
    ]) {
      await fill(fixture, root, id!, value!);
    }
    await save(fixture, root);
    expect(puts(server)).toEqual([
      {
        ...CONFIGURED.budgets,
        explainPerDay: 0,
        triagePerDay: 100_000,
        fixPerDay: 0,
        tokensPerDay: 1_000_000_000,
        perUserPerHour: 10_000,
      },
    ]);
    await fill(fixture, root, 'ai-budget-user', '10001');
    await save(fixture, root);
    expect(errorOf(root, 'ai-budget-user')).toBe('Use a whole number, 1 or more.');
    expect(puts(server)).toHaveLength(1);
  });

  it('maps the server’s refusal of a limit to its field, never showing its text', async () => {
    for (const [path, id] of [
      ['body.budgets.explainPerDay', 'ai-budget-explain'],
      ['body.budgets.triagePerDay', 'ai-budget-triage'],
      ['body.budgets.fixPerDay', 'ai-budget-fix'],
      ['body.budgets.tokensPerDay', 'ai-budget-tokens'],
      ['body.budgets.perUserPerHour', 'ai-budget-user'],
    ] as const) {
      TestBed.resetTestingModule();
      setup(() => ({
        status: 422,
        body: problem(422, 'VALIDATION_FAILED', [{ path, message: 'server text' }]),
      }));
      const { fixture, root } = await render();
      await fill(fixture, root, id, '5');
      await save(fixture, root);
      expect(field(root, id).getAttribute('aria-invalid'), path).toBe('true');
      expect(root.textContent).not.toContain('server text');
    }
  });

  it('says in its foot why a save failed, and keeps the edits', async () => {
    setup(() => ({ status: 500, body: problem(500, 'INTERNAL') }));
    const { fixture, root } = await render();
    await fill(fixture, root, 'ai-budget-explain', '300');
    await save(fixture, root);
    expect(foot(root)).toMatch(/\S/);
    expect(foot(root)).not.toBe('1 unsaved change');
    expect(root.querySelector('.foot-status.bad')).not.toBeNull();
    expect(field(root, 'ai-budget-explain').value).toBe('300');
    // Save stays pressable, to try again as it is.
    expect(saveButton(root).disabled).toBe(false);
    await fill(fixture, root, 'ai-budget-explain', '301');
    expect(foot(root)).toBe('1 unsaved change');
  });
});

describe('LimitsSection: the cost', () => {
  it('is disabled without prices, under a requirement that leads to Provider → Prices', async () => {
    setup();
    const { fixture, root } = await render();
    const costSwitch = field(root, 'ai-budget-cost-set');
    expect(costSwitch.disabled).toBe(true);
    const note = root.querySelector('#ai-budget-no-prices')!;
    expect(note.classList).toContain('req');
    // The note stands right above the switch it disables.
    expect(note.nextElementSibling?.contains(costSwitch)).toBe(true);
    // Its link goes to the prices' switch on this page.
    const prices = document.createElement('input');
    prices.id = 'ai-prices';
    document.body.append(prices);
    try {
      const link = note.querySelector('a')!;
      expect(text(link)).toBe('Provider → Prices');
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      link.dispatchEvent(event);
      await settle(fixture);
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(prices);
    } finally {
      prices.remove();
    }
  });

  it('takes a cost per day in US$ under its switch once prices are set', async () => {
    const server = setup();
    const { fixture, root } = await render({ settings: WITH_PRICES });
    expect(root.querySelector('#ai-budget-no-prices')).toBeNull();
    const costSwitch = field(root, 'ai-budget-cost-set');
    expect(costSwitch.disabled).toBe(false);
    await click(fixture, costSwitch);
    expect(labelOf(root, 'ai-budget-cost')).toBe('Cost per day');
    expect(field(root, 'ai-budget-cost').inputMode).toBe('decimal');
    expect(text(root.querySelector('#ai-budget-cost-prefix'))).toBe('US$');
    expect(described(root, 'ai-budget-cost')).toContain('US$');
    // Switched on and left empty, the limit is refused, not taken for none.
    await save(fixture, root);
    expect(errorOf(root, 'ai-budget-cost')).toBe(
      'Use an amount in US dollars, or switch the cost limit off.',
    );
    await fill(fixture, root, 'ai-budget-cost', '2.5');
    await save(fixture, root);
    expect(puts(server)).toEqual([{ ...CONFIGURED.budgets, costPerDayUsd: 2.5 }]);
    expect(field(root, 'ai-budget-cost').value).toBe('2.50');

    // Off again: the limit goes, and its field with it.
    await click(fixture, costSwitch);
    expect(root.querySelector('#ai-budget-cost')).toBeNull();
    await save(fixture, root);
    expect(puts(server)[1]).toEqual({ ...CONFIGURED.budgets, costPerDayUsd: null });
  });

  it('refuses an amount that is not money up to 1 000 000 US$', async () => {
    const server = setup();
    const { fixture, root } = await render({
      settings: { ...WITH_PRICES, budgets: { ...CONFIGURED.budgets, costPerDayUsd: 2 } },
    });
    expect(field(root, 'ai-budget-cost-set').checked).toBe(true);
    expect(field(root, 'ai-budget-cost').value).toBe('2.00');
    for (const value of ['abc', '1.234', '1000000.01', '-1']) {
      await fill(fixture, root, 'ai-budget-cost', value);
      await save(fixture, root);
      expect(errorOf(root, 'ai-budget-cost'), value).toBe(
        'Use an amount in US dollars, or switch the cost limit off.',
      );
    }
    expect(puts(server)).toEqual([]);
  });

  it('sends a stored cost back as stored, its decimals all, unless its field is edited', async () => {
    const server = setup();
    const { fixture, root } = await render({
      settings: { ...WITH_PRICES, budgets: { ...CONFIGURED.budgets, costPerDayUsd: 1.255 } },
    });
    expect(field(root, 'ai-budget-cost').value).toBe('1.255');
    await fill(fixture, root, 'ai-budget-explain', '300');
    expect(foot(root)).toBe('1 unsaved change');
    await save(fixture, root);
    expect(puts(server)).toEqual([
      { ...CONFIGURED.budgets, explainPerDay: 300, costPerDayUsd: 1.255 },
    ]);
    expect(field(root, 'ai-budget-cost').value).toBe('1.255');
    // Edited, it is the amount typed.
    await fill(fixture, root, 'ai-budget-cost', '1.26');
    await save(fixture, root);
    expect(puts(server)[1]).toMatchObject({ costPerDayUsd: 1.26 });
  });

  it('keeps a stored cost limit switchable off without prices', async () => {
    const server = setup();
    const { fixture, root } = await render({
      settings: { ...CONFIGURED, budgets: { ...CONFIGURED.budgets, costPerDayUsd: 2 } },
    });
    const costSwitch = field(root, 'ai-budget-cost-set');
    expect(costSwitch.checked).toBe(true);
    expect(costSwitch.disabled).toBe(false);
    expect(root.querySelector('#ai-budget-no-prices')).not.toBeNull();
    await click(fixture, costSwitch);
    expect(costSwitch.disabled).toBe(true);
    await save(fixture, root);
    expect(puts(server)).toEqual([{ ...CONFIGURED.budgets, costPerDayUsd: null }]);
  });
});

describe('LimitsSection: the AI review cap (6I-2 Task 9)', () => {
  it('has the cap under its switch, with its unit and its hint', async () => {
    setup();
    const { root } = await render({ settings: WITH_CEILING });
    expect(text(root.querySelector('#ai-limits-review'))).toBe('AI review');
    expect(text(root.querySelector('#ai-limits-review + .hint'))).toBe(
      "Each organization's admin sets its own review budgets in Settings → AI, 2,000,000 tokens a day by default. They are separate from the limits above.",
    );
    expect(field(root, 'ai-budget-review-set').checked).toBe(true);
    expect(labelOf(root, 'ai-budget-review')).toBe('Tokens per day, per organization');
    expect(field(root, 'ai-budget-review').value).toBe('750,000');
    expect(described(root, 'ai-budget-review')).toEqual([
      'Organization admins can set less, never more.',
      'tokens',
    ]);
  });

  it('sends the stored cap back with every save, and null, not nothing, while there is none', async () => {
    const server = setup();
    const first = await render({ settings: WITH_CEILING });
    await fill(first.fixture, first.root, 'ai-budget-fix', '30');
    await save(first.fixture, first.root);
    expect(puts(server)).toEqual([
      { ...CONFIGURED.budgets, fixPerDay: 30, reviewTokensPerOrganizationPerDay: 750_000 },
    ]);

    TestBed.resetTestingModule();
    const none = setup();
    const second = await render();
    await fill(second.fixture, second.root, 'ai-budget-fix', '30');
    await save(second.fixture, second.root);
    expect(puts(none)[0]).toHaveProperty('reviewTokensPerOrganizationPerDay', null);
  });

  it('sets a cap, and removes it by switching it off', async () => {
    const server = setup();
    const { fixture, root } = await render();
    await click(fixture, field(root, 'ai-budget-review-set'));
    expect(foot(root)).toBe('1 unsaved change');
    await fill(fixture, root, 'ai-budget-review', '1000000');
    await save(fixture, root);
    expect(puts(server)[0]).toMatchObject({ reviewTokensPerOrganizationPerDay: 1_000_000 });
    // The saved answer fills the field again.
    expect(field(root, 'ai-budget-review').value).toBe('1,000,000');
    await click(fixture, field(root, 'ai-budget-review-set'));
    expect(root.querySelector('#ai-budget-review')).toBeNull();
    // Switched on again before a save, the field shows what it held.
    await click(fixture, field(root, 'ai-budget-review-set'));
    expect(field(root, 'ai-budget-review').value).toBe('1,000,000');
    expect(foot(root)).toMatch(/^Saved at /);
    await click(fixture, field(root, 'ai-budget-review-set'));
    await save(fixture, root);
    expect(puts(server)[1]).toMatchObject({ reviewTokensPerOrganizationPerDay: null });
    expect(field(root, 'ai-budget-review-set').checked).toBe(false);
  });

  it('takes 0 (no organisation may review) and refuses what is not a whole number up to 1 000 000 000', async () => {
    const server = setup();
    const { fixture, root } = await render();
    await click(fixture, field(root, 'ai-budget-review-set'));
    await fill(fixture, root, 'ai-budget-review', '0');
    await save(fixture, root);
    expect(puts(server)[0]).toMatchObject({ reviewTokensPerOrganizationPerDay: 0 });
    for (const value of ['', '-1', '1.5', '1000000001']) {
      await fill(fixture, root, 'ai-budget-review', value);
      await save(fixture, root);
      expect(field(root, 'ai-budget-review').getAttribute('aria-invalid'), value).toBe('true');
      expect(errorOf(root, 'ai-budget-review'), value).toBe(
        'Use a whole number, 0 or more, or switch the cap off.',
      );
    }
    expect(puts(server)).toHaveLength(1);
  });

  it('maps the server’s refusal of the cap to its field', async () => {
    setup(() => ({
      status: 422,
      body: problem(422, 'VALIDATION_FAILED', [
        { path: 'body.budgets.reviewTokensPerOrganizationPerDay', message: 'server text' },
      ]),
    }));
    const { fixture, root } = await render();
    await click(fixture, field(root, 'ai-budget-review-set'));
    await fill(fixture, root, 'ai-budget-review', '5');
    await save(fixture, root);
    expect(field(root, 'ai-budget-review').getAttribute('aria-invalid')).toBe('true');
    expect(foot(root)).toBe('1 field needs attention: Tokens per day, per organization');
    expect(root.textContent).not.toContain('server text');
  });
});

describe('LimitsSection: its draft', () => {
  it('is dirty while a limit differs from what is saved, by value', async () => {
    setup();
    const { fixture, root, section } = await render();
    expect(section.dirty()).toBe(false);
    await fill(fixture, root, 'ai-budget-tokens', '2000000');
    expect(section.dirty()).toBe(true);
    expect(root.querySelector('label[for="ai-budget-tokens"]')?.classList).toContain('changed');
    // The same number, grouped otherwise, is no change.
    await fill(fixture, root, 'ai-budget-tokens', '1 000 000');
    expect(section.dirty()).toBe(false);
    expect(foot(root)).toBe('No unsaved changes');
  });

  it('takes new settings into the fields not edited, and keeps an edit', async () => {
    setup();
    const { fixture, root } = await render();
    await fill(fixture, root, 'ai-budget-explain', '300');
    // Another section's save: the server's answer holds limits changed meanwhile elsewhere.
    fixture.componentRef.setInput('settings', {
      ...CONFIGURED,
      budgets: { ...CONFIGURED.budgets, explainPerDay: 250, triagePerDay: 150 },
    });
    await settle(fixture);
    expect(field(root, 'ai-budget-explain').value).toBe('300');
    expect(field(root, 'ai-budget-triage').value).toBe('150');
    expect(foot(root)).toBe('1 unsaved change');
  });

  it('keeps an edit made while its save is on its way, unsaved', async () => {
    setup();
    let answer: (saved: LlmSettings) => void = noAnswerYet;
    const sent: Budgets[] = [];
    const { fixture, root } = await render({
      saveLimits: (budgets) => {
        sent.push(budgets);
        return new Promise((resolve) => (answer = resolve));
      },
    });
    await fill(fixture, root, 'ai-budget-explain', '300');
    await save(fixture, root);
    expect(foot(root)).toBe('Saving…');
    await fill(fixture, root, 'ai-budget-triage', '150');
    const saved = { ...CONFIGURED, budgets: { ...CONFIGURED.budgets, explainPerDay: 300 } };
    answer(saved as LlmSettings);
    await settle(fixture);
    fixture.componentRef.setInput('settings', saved);
    await settle(fixture);
    expect(sent).toEqual([{ ...CONFIGURED.budgets, explainPerDay: 300 }]);
    expect(field(root, 'ai-budget-explain').value).toBe('300');
    expect(field(root, 'ai-budget-triage').value).toBe('150');
    expect(foot(root)).toBe('1 unsaved change');
  });
});
