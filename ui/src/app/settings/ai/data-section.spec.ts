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
import { DataSection, type SaveData } from './data-section';
import { bodyFrom, type LlmBody, type LlmSettings } from './llm-body';

type Fixture = { whenStable(): Promise<unknown> };
type Sent = Pick<LlmBody, 'excludePaths' | 'storePrompts' | 'promptRetentionDays'>;

const PATHS = { ...CONFIGURED, excludePaths: ['config/**', '**/*.pem'] };
const COPIES = { ...CONFIGURED, storePrompts: true, promptRetentionDays: 30 };
const BAD_GLOB = 'Use a glob from the repository root, such as config/** or **/*.pem.';

/** The settings the server holds: what the section was given, then what each save stored. */
let stored: LlmSettings;

function setup(reply?: (body: LlmBody) => FakeReply): FakeServer {
  const server = new FakeServer();
  server.on('PUT', '/api/v0/system/llm', (request) => {
    const body = request.body as LlmBody;
    return (
      reply?.(body) ?? {
        body: {
          ...stored,
          excludePaths: body.excludePaths,
          storePrompts: body.storePrompts,
          promptRetentionDays: body.promptRetentionDays,
        },
      }
    );
  });
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: '**', children: [] }]), provideFakeServer(server)],
  });
  TestBed.inject(SessionStore).set(me({ admin: true }));
  return server;
}

/**
 * The section with the settings given. Its save does what the page does: the stored settings with
 * the section's fields go to the server, whose answer becomes the section's settings.
 */
async function render(given: { settings?: object; saveData?: SaveData } = {}) {
  const fixture = TestBed.createComponent(DataSection);
  stored = (given.settings ?? CONFIGURED) as LlmSettings;
  const api = TestBed.inject(Api);
  const saveData: SaveData =
    given.saveData ??
    (async (data) => {
      const body = bodyFrom(stored, { section: 'data', ...data });
      const saved = await ok(api.client.PUT('/api/v0/system/llm', { body }));
      stored = saved;
      fixture.componentRef.setInput('settings', saved);
      return saved;
    });
  fixture.componentRef.setInput('settings', stored);
  fixture.componentRef.setInput('host', 'ollama:11434');
  fixture.componentRef.setInput('saveData', saveData);
  await settle(fixture);
  return {
    fixture,
    root: fixture.nativeElement as HTMLElement,
    section: fixture.componentInstance,
  };
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();
const field = (root: HTMLElement, id: string) => root.querySelector<HTMLInputElement>(`#${id}`)!;
const foot = (root: HTMLElement) => text(root.querySelector('.foot-status'));
const button = (within: Element, name: string) =>
  [...within.querySelectorAll('button')].find((b) => text(b) === name)!;
const items = (root: HTMLElement) =>
  [...root.querySelectorAll('.list-editor li .item')].map((item) => text(item));
const puts = (server: FakeServer) =>
  server.requestsTo('PUT', '/api/v0/system/llm').map((r) => {
    const { excludePaths, storePrompts, promptRetentionDays } = r.body as LlmBody;
    return { excludePaths, storePrompts, promptRetentionDays } satisfies Sent;
  });
/** The texts an input's `aria-describedby` names. */
const described = (root: HTMLElement, id: string) =>
  (field(root, id).getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter((ref) => ref !== '')
    .map((ref) => text(root.querySelector(`#${ref}`)));

async function click(fixture: Fixture, target: HTMLElement | null | undefined) {
  target!.click();
  await settle(fixture);
}
async function fill(fixture: Fixture, root: HTMLElement, id: string, value: string) {
  type(root, `#${id}`, value);
  await settle(fixture);
}
/** Types a pattern and presses Add. */
async function add(fixture: Fixture, root: HTMLElement, pattern: string) {
  await fill(fixture, root, 'ai-exclude-add', pattern);
  await click(fixture, button(root, 'Add'));
}
const save = (fixture: Fixture, root: HTMLElement) =>
  click(fixture, button(root, 'Save data and privacy'));

describe('DataSection: what is sent', () => {
  it('says what each feature sends, to whom, and what is never sent', async () => {
    setup();
    const { root, section } = await render();
    expect(section.dirtyLabel).toBe('Data and privacy');
    expect(text(root.querySelector('#ai-data-heading'))).toBe('Data and privacy');
    expect(text(root.querySelector('.sec-purpose'))).toBe(
      'What leaves this server, and what Qualor keeps of it.',
    );
    expect(text(root.querySelector('#ai-data-sent-help'))).toBe(
      'To ollama:11434, for the organizations you allow.',
    );
    const table = root.querySelector('table')!;
    expect([...table.querySelectorAll('thead th')].map((th) => text(th))).toEqual([
      'Feature',
      'Starts it',
      'What the model gets',
    ]);
    expect(
      [...table.querySelectorAll('tbody tr')].map((tr) =>
        [...tr.querySelectorAll('th, td')].map((cell) => text(cell)),
      ),
    ).toEqual([
      [
        'Explain, triage, a fix',
        'A person, for one issue',
        'The rule, the message, the path, the language, 3 lines of code each side, redacted',
      ],
      [
        'Automatic fix suggestions Enterprise',
        'Each merge request analysis, once an organization admin switched them on',
        'As for a fix, for the new findings',
      ],
      [
        'AI review',
        'Each merge request analysis, once an organization admin switched it on and confirmed',
        'The diff, and any file the model reads from the masked copy of the repository',
      ],
      [
        'Answers to replies',
        "A person replying in one of Qualor's threads",
        'That thread, and the files the model reads',
      ],
    ]);
    // On a phone each cell names its column.
    expect(
      [...table.querySelectorAll('tbody tr:first-child :is(th, td)')].map((cell) =>
        cell.getAttribute('data-label'),
      ),
    ).toEqual(['Feature', 'Starts it', 'What the model gets']);
    expect(text(root.querySelector('#ai-data-never'))).toBe(
      'Never sent: findings of secret rules (by the three actions), credentials files, and the projects and paths you exclude.',
    );
    expect(foot(root)).toBe('No unsaved changes');
  });
});

describe('DataSection: the paths never sent', () => {
  it('lists them, adds a pattern with Add or Enter, removes one, and saves the list', async () => {
    const server = setup();
    const { fixture, root, section } = await render({ settings: PATHS });
    expect(text(root.querySelector('#ai-exclude-name'))).toBe('Never send these paths');
    expect(text(root.querySelector('#ai-exclude-help'))).toBe(
      'For every organization and for AI review: the model never sees these files. The scanner still uploads them to this server.',
    );
    expect(items(root)).toEqual(['config/**', '**/*.pem']);
    const input = field(root, 'ai-exclude-add');
    expect(input.getAttribute('aria-label')).toBe('Add a path pattern');
    expect(described(root, 'ai-exclude-add')).toEqual([
      'A glob from the repository root; at most 100.',
    ]);

    input.focus();
    await add(fixture, root, ' legacy/** ');
    expect(items(root)).toEqual(['config/**', '**/*.pem', 'legacy/**']);
    expect(input.value).toBe('');
    expect(section.dirty()).toBe(true);
    expect(foot(root)).toBe('1 unsaved change');
    // Enter adds too, as Add does.
    await fill(fixture, root, 'ai-exclude-add', 'vendor/**');
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    input.dispatchEvent(enter);
    await settle(fixture);
    expect(enter.defaultPrevented).toBe(true);
    expect(items(root)).toEqual(['config/**', '**/*.pem', 'legacy/**', 'vendor/**']);

    const remove = button(root.querySelector('.list-editor li')!, 'Remove');
    expect(remove.getAttribute('aria-label')).toBe('Remove config/**');
    remove.focus();
    await click(fixture, remove);
    expect(items(root)).toEqual(['**/*.pem', 'legacy/**', 'vendor/**']);
    // The focus goes to the Remove that took its place.
    expect(document.activeElement).toBe(button(root.querySelector('.list-editor li')!, 'Remove'));
    expect(foot(root)).toBe('3 unsaved changes');

    await save(fixture, root);
    expect(puts(server)).toEqual([
      {
        excludePaths: ['**/*.pem', 'legacy/**', 'vendor/**'],
        storePrompts: false,
        promptRetentionDays: 7,
      },
    ]);
    expect(foot(root)).toMatch(/^Saved at \d{1,2}:\d{2} [AP]M UTC\.$/);
    expect(section.dirty()).toBe(false);
  });

  it('leaves the focus with the add field when the last path goes', async () => {
    setup();
    const { fixture, root } = await render({ settings: { ...CONFIGURED, excludePaths: ['a/**'] } });
    const remove = button(root.querySelector('.list-editor li')!, 'Remove');
    remove.focus();
    await click(fixture, remove);
    expect(items(root)).toEqual([]);
    expect(root.querySelector('.list-editor')).toBeNull();
    expect(document.activeElement).toBe(field(root, 'ai-exclude-add'));
  });

  it('refuses a pattern that is no glob from the repository root, or one already listed', async () => {
    setup();
    const { fixture, root } = await render({ settings: PATHS });
    for (const pattern of ['', '   ', '/etc/**', 'a\u0000b', 'x'.repeat(201), 'config/**']) {
      await add(fixture, root, pattern);
      expect(field(root, 'ai-exclude-add').getAttribute('aria-invalid'), pattern).toBe('true');
      expect(text(root.querySelector('#ai-exclude-add-error')), pattern).toBe(BAD_GLOB);
      expect(items(root), pattern).toEqual(['config/**', '**/*.pem']);
    }
    expect(described(root, 'ai-exclude-add')).toEqual([
      BAD_GLOB,
      'A glob from the repository root; at most 100.',
    ]);
    expect(document.activeElement).toBe(field(root, 'ai-exclude-add'));
    // A pattern refused is no refusal of the section: nothing to save is wrong.
    expect(foot(root)).toBe('No unsaved changes');
    // Typing again clears the refusal; 200 characters are a glob.
    await fill(fixture, root, 'ai-exclude-add', 'x'.repeat(200));
    expect(root.querySelector('#ai-exclude-add-error')).toBeNull();
    await click(fixture, button(root, 'Add'));
    expect(items(root)).toHaveLength(3);
    // The list added to stays savable while a pattern is refused.
    await add(fixture, root, 'config/**');
    expect(text(root.querySelector('#ai-exclude-add-error'))).toBe(BAD_GLOB);
    expect(foot(root)).toBe('1 unsaved change');
    expect(button(root, 'Save data and privacy').hasAttribute('disabled')).toBe(false);
  });

  it('refuses a 101st path', async () => {
    const server = setup();
    const hundred = Array.from({ length: 100 }, (_, i) => `p${i}/**`);
    const { fixture, root } = await render({ settings: { ...CONFIGURED, excludePaths: hundred } });
    await add(fixture, root, 'one-more/**');
    expect(text(root.querySelector('#ai-exclude-add-error'))).toBe(
      'Use at most 100 globs, relative to the repository root.',
    );
    expect(items(root)).toHaveLength(100);
    expect(field(root, 'ai-exclude-add').value).toBe('one-more/**');
    expect(puts(server)).toEqual([]);
  });

  it('maps the server’s refusal of the paths to the add field', async () => {
    for (const [path, message] of [
      ['body.excludePaths.0', BAD_GLOB],
      ['body.excludePaths', 'Use at most 100 globs, relative to the repository root.'],
    ] as const) {
      TestBed.resetTestingModule();
      setup(() => ({
        status: 422,
        body: problem(422, 'VALIDATION_FAILED', [{ path, message: 'server text' }]),
      }));
      const { fixture, root } = await render();
      await add(fixture, root, 'legacy/**');
      await save(fixture, root);
      expect(text(root.querySelector('#ai-exclude-add-error')), path).toBe(message);
      expect(foot(root)).toBe('1 field needs attention: Never send these paths');
      expect(root.textContent).not.toContain('server text');
      expect(items(root)).toEqual(['legacy/**']);
    }
  });
});

describe('DataSection: the copies of what is sent', () => {
  it('keeps them for the days under the switch, from 1 to 90', async () => {
    const server = setup();
    const { fixture, root } = await render();
    expect(text(root.querySelector('#ai-copies-name'))).toBe('Copies of what is sent');
    expect(text(root.querySelector('#ai-copies-help'))).toBe(
      'Off: only the model, the tokens, the time and the answer are kept.',
    );
    const copies = field(root, 'ai-store-prompts');
    expect(copies.getAttribute('role')).toBe('switch');
    expect(copies.checked).toBe(false);
    expect(text(root.querySelector(`#${copies.getAttribute('aria-labelledby')}`))).toBe(
      'Keep a copy of what is sent',
    );
    expect(described(root, 'ai-store-prompts')).toEqual([
      'The exact data, after masking; for AI review that includes repository code.',
    ]);
    expect(root.querySelector('#ai-retention')).toBeNull();

    await click(fixture, copies);
    expect(text(root.querySelector('label[for="ai-retention"]'))).toBe('Keep for');
    expect(field(root, 'ai-retention').value).toBe('7');
    expect(described(root, 'ai-retention')).toEqual(['days']);
    for (const value of ['0', '91', '1.5', 'x']) {
      await fill(fixture, root, 'ai-retention', value);
      await save(fixture, root);
      expect(text(root.querySelector('#ai-retention-error')), value).toBe(
        'Use a whole number of days from 1 to 90.',
      );
      expect(field(root, 'ai-retention').getAttribute('aria-invalid'), value).toBe('true');
    }
    expect(puts(server)).toEqual([]);
    await fill(fixture, root, 'ai-retention', '90');
    await save(fixture, root);
    expect(puts(server)).toEqual([
      { excludePaths: [], storePrompts: true, promptRetentionDays: 90 },
    ]);
  });

  it('switched off, sends the stored days unchanged', async () => {
    const server = setup();
    const { fixture, root } = await render({ settings: COPIES });
    expect(field(root, 'ai-retention').value).toBe('30');
    await fill(fixture, root, 'ai-retention', '45');
    await click(fixture, field(root, 'ai-store-prompts'));
    expect(root.querySelector('#ai-retention')).toBeNull();
    // Off, a changed number of days is no change: the switch is the one change.
    expect(foot(root)).toBe('1 unsaved change');
    await save(fixture, root);
    expect(puts(server)).toEqual([
      { excludePaths: [], storePrompts: false, promptRetentionDays: 30 },
    ]);
  });

  it('maps the server’s refusal of the days to their field', async () => {
    setup(() => ({
      status: 422,
      body: problem(422, 'VALIDATION_FAILED', [
        { path: 'body.promptRetentionDays', message: 'server text' },
      ]),
    }));
    const { fixture, root } = await render({ settings: COPIES });
    await fill(fixture, root, 'ai-retention', '20');
    await save(fixture, root);
    expect(field(root, 'ai-retention').getAttribute('aria-invalid')).toBe('true');
    expect(foot(root)).toBe('1 field needs attention: Keep for');
    expect(document.activeElement).toBe(field(root, 'ai-retention'));
    expect(root.textContent).not.toContain('server text');
  });
});

describe('DataSection: its draft', () => {
  it('takes new settings into what is not edited, and keeps an edit', async () => {
    setup();
    const { fixture, root } = await render({ settings: PATHS });
    await add(fixture, root, 'legacy/**');
    // Another section's save: the copies changed meanwhile elsewhere.
    fixture.componentRef.setInput('settings', { ...PATHS, storePrompts: true });
    await settle(fixture);
    expect(items(root)).toEqual(['config/**', '**/*.pem', 'legacy/**']);
    expect(field(root, 'ai-store-prompts').checked).toBe(true);
    expect(foot(root)).toBe('1 unsaved change');
  });

  it('keeps an edit made while its save is on its way, unsaved', async () => {
    setup();
    let answer: (saved: LlmSettings) => void = () => undefined;
    const sent: Sent[] = [];
    const { fixture, root } = await render({
      settings: PATHS,
      saveData: (data) => {
        sent.push(data);
        return new Promise((resolve) => (answer = resolve));
      },
    });
    await add(fixture, root, 'legacy/**');
    await save(fixture, root);
    expect(foot(root)).toBe('Saving…');
    await click(fixture, field(root, 'ai-store-prompts'));
    const saved = { ...PATHS, excludePaths: ['config/**', '**/*.pem', 'legacy/**'] };
    answer(saved as LlmSettings);
    await settle(fixture);
    fixture.componentRef.setInput('settings', saved);
    await settle(fixture);
    expect(sent).toEqual([
      {
        excludePaths: ['config/**', '**/*.pem', 'legacy/**'],
        storePrompts: false,
        promptRetentionDays: 7,
      },
    ]);
    expect(items(root)).toEqual(['config/**', '**/*.pem', 'legacy/**']);
    expect(field(root, 'ai-store-prompts').checked).toBe(true);
    expect(foot(root)).toBe('1 unsaved change');
  });
});
