import {
  CONFIGURED,
  render,
  setup,
  submit,
  testAnswer,
  type,
  type TestAnswer,
} from '../../testing/ai-settings';
import type { FakeServer } from '../../testing/fake-server';
import { problem, settle } from '../../testing/fake-server';

describe('AiSettingsPage: the current Anthropic models (6I-4)', () => {
  /** A provider of kind Anthropic, as the server shows it: its temperature is always null. */
  const ANTHROPIC = {
    ...CONFIGURED,
    provider: {
      ...CONFIGURED.provider,
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-5-5',
    },
  };
  const WORKSPACE = 'wrkspc_01AbCdEf';
  const field = (root: HTMLElement, id: string) => root.querySelector<HTMLInputElement>(`#${id}`)!;
  const rowOf = (root: HTMLElement, id: string) => field(root, id).closest('.setting-row');
  type PutBody = { provider: Record<string, unknown> };
  /** The body of the first save the page sent. */
  const sent = (server: FakeServer) =>
    server.requestsTo('PUT', '/api/v0/system/llm')[0]?.body as PutBody | undefined;
  /** Chooses a kind on the page, as the admin does. */
  const choose = async (
    fixture: { whenStable(): Promise<unknown> },
    root: HTMLElement,
    kind: string,
  ) => {
    type(root, '#ai-kind', kind);
    await settle(fixture);
  };

  describe('the workspace ID', () => {
    it('is a field of an Anthropic provider only, right after the API key, with its hint', async () => {
      setup();
      const { fixture, root } = await render();
      expect(root.querySelector('#ai-workspace-id')).toBeNull();
      await choose(fixture, root, 'openai');
      expect(root.querySelector('#ai-workspace-id')).toBeNull();
      await choose(fixture, root, 'anthropic');
      const input = field(root, 'ai-workspace-id');
      expect(root.querySelector('label[for="ai-workspace-id"]')?.textContent?.trim()).toBe(
        'Workspace ID',
      );
      expect(root.querySelector('#ai-workspace-id-hint')?.textContent?.trim()).toBe(
        'For an organisation-wide key that is not scoped to a workspace (wrkspc_…).',
      );
      // Not a secret: a plain text field of at most the 71 characters of an ID, and optional.
      expect([input.type, input.maxLength, input.value, input.required]).toEqual([
        'text',
        71,
        '',
        false,
      ]);
      expect(input.getAttribute('aria-describedby')).toBe('ai-workspace-id-hint');
      expect(input.getAttribute('aria-invalid')).toBeNull();
      expect(rowOf(root, 'ai-key')?.nextElementSibling).toBe(rowOf(root, 'ai-workspace-id'));
      // And gone again with another kind.
      await choose(fixture, root, 'openai');
      expect(root.querySelector('#ai-workspace-id')).toBeNull();
    });

    it('shows the stored workspace ID as it was entered', async () => {
      setup({ ...ANTHROPIC, provider: { ...ANTHROPIC.provider, workspaceId: WORKSPACE } });
      const { root } = await render();
      expect(field(root, 'ai-workspace-id').value).toBe(WORKSPACE);
    });

    it('sends it trimmed, and null when the field is empty', async () => {
      const server = setup(ANTHROPIC);
      server.on('PUT', '/api/v0/system/llm', { body: ANTHROPIC });
      const { fixture, root } = await render();
      submit(root);
      await settle(fixture);
      expect(sent(server)?.provider).toMatchObject({ kind: 'anthropic', workspaceId: null });

      type(root, '#ai-workspace-id', `  ${WORKSPACE} `);
      submit(root);
      await settle(fixture);
      expect(server.requestsTo('PUT', '/api/v0/system/llm')[1]?.body).toMatchObject({
        provider: { kind: 'anthropic', workspaceId: WORKSPACE },
      });
    });

    it('sends none for another kind, whatever was typed under Anthropic', async () => {
      const server = setup(ANTHROPIC);
      server.on('PUT', '/api/v0/system/llm', { body: CONFIGURED });
      const { fixture, root } = await render();
      type(root, '#ai-workspace-id', WORKSPACE);
      await choose(fixture, root, 'openai');
      submit(root);
      await settle(fixture);
      expect(sent(server)?.provider).toMatchObject({ kind: 'openai' });
      expect(sent(server)?.provider).not.toHaveProperty('workspaceId');
    });

    it.each([
      ['without the prefix', '01AbCdEf'],
      ['the prefix alone', 'wrkspc_'],
      ['another prefix', 'workspace_01AbCd'],
      ['with a space in it', 'wrkspc_01 AbCd'],
      ['with a dash in it', 'wrkspc_01-AbCd'],
      ['over 64 characters after the prefix', `wrkspc_${'a'.repeat(65)}`],
    ])(
      'refuses one %s on its own field, in the page’s words, and sends nothing',
      async (_what, value) => {
        const server = setup(ANTHROPIC);
        const { fixture, root } = await render();
        type(root, '#ai-workspace-id', value);
        submit(root);
        await settle(fixture);
        expect(server.requestsTo('PUT', '/api/v0/system/llm')).toHaveLength(0);
        const input = field(root, 'ai-workspace-id');
        expect(input.getAttribute('aria-invalid')).toBe('true');
        expect(root.querySelector('#ai-workspace-id-error')?.textContent).toContain(
          'Use the workspace ID as the console shows it: wrkspc_ and then letters and digits',
        );
        expect(input.getAttribute('aria-describedby')).toBe(
          'ai-workspace-id-error ai-workspace-id-hint',
        );
        expect(document.activeElement).toBe(input);
        // Typing again takes the refusal back.
        type(root, '#ai-workspace-id', WORKSPACE);
        await settle(fixture);
        expect(root.querySelector('#ai-workspace-id-error')).toBeNull();
        expect(input.getAttribute('aria-invalid')).toBeNull();
      },
    );

    it('maps the server’s refusal at body.provider.workspaceId to its field, in the page’s words', async () => {
      const server = setup(ANTHROPIC);
      server.on('PUT', '/api/v0/system/llm', {
        status: 422,
        body: problem(422, 'VALIDATION_FAILED', [
          { path: 'body.provider.workspaceId', message: 'server text' },
        ]),
      });
      const { fixture, root } = await render();
      submit(root);
      await settle(fixture);
      expect(field(root, 'ai-workspace-id').getAttribute('aria-invalid')).toBe('true');
      expect(root.querySelector('#ai-workspace-id-error')?.textContent).toContain(
        'Use the workspace ID as the console shows it',
      );
      expect(root.textContent).not.toContain('server text');
      expect(root.querySelector('.alert-error')).toBeNull();
    });
  });

  describe('the Test of a key that is not scoped to a workspace', () => {
    const WORDS = 'This key is not scoped to a workspace: give its workspace ID below.';
    const refused = {
      code: 'PROVIDER_WORKSPACE_REQUIRED',
      message: 'server text',
      providerStatus: 400,
    } as const;
    const pressTest = async (fixture: { whenStable(): Promise<unknown> }, root: HTMLElement) => {
      [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Test')!.click();
      await settle(fixture);
    };

    it('is named in the page’s own words, and nothing of the server’s is shown', async () => {
      const server = setup(ANTHROPIC);
      server.on('POST', '/api/v0/system/llm/test', {
        body: testAnswer({
          ok: false,
          model: null,
          latencyMs: 12,
          toolCalling: 'not_checked',
          problem: refused,
        }),
      });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(root.querySelector('.alert-error[role="alert"]')?.textContent).toContain(WORDS);
      expect(root.textContent).not.toContain('server text');
      // The field it points to is on the page, below this message.
      const alert = root.querySelector('.alert-error[role="alert"]')!;
      const field = root.querySelector('#ai-workspace-id')!;
      expect(alert.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('is the line of each model the key was refused for, in the page’s words', async () => {
      const server = setup({
        ...ANTHROPIC,
        provider: { ...ANTHROPIC.provider, strongModel: 'claude-opus-5-5' },
      });
      const line = (tier: 'standard' | 'strong', model: string) => ({
        tier,
        model,
        ok: false,
        reportedModel: null,
        latencyMs: 12,
        toolCalling: 'not_checked' as const,
        problem: refused,
        hint: null,
      });
      server.on('POST', '/api/v0/system/llm/test', {
        body: {
          ok: false,
          model: null,
          latencyMs: 12,
          toolCalling: 'not_checked',
          problem: refused,
          hint: null,
          models: [line('standard', 'claude-sonnet-5-5'), line('strong', 'claude-opus-5-5')],
        } satisfies TestAnswer,
      });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(
        [...root.querySelectorAll('#ai-test-models li')].map((li) => li.textContent?.trim()),
      ).toEqual([`claude-sonnet-5-5: ${WORDS}`, `claude-opus-5-5: ${WORDS}`]);
      expect(root.textContent).not.toContain('server text');
    });
  });

  describe('the temperature', () => {
    const HINT = "Anthropic's current models take no temperature: leave it empty.";

    it('is shown empty for an Anthropic provider, with the hint, and cannot be typed', async () => {
      setup(ANTHROPIC);
      const { root } = await render();
      const input = field(root, 'ai-temperature');
      expect(input.value).toBe('');
      expect(input.disabled).toBe(true);
      expect(root.querySelector('#ai-temperature-hint')?.textContent?.trim()).toBe(HINT);
      expect(input.getAttribute('aria-describedby')).toBe('ai-temperature-hint');
    });

    it('is a field of OpenAI-compatible providers up to 2, without the hint', async () => {
      setup({ ...CONFIGURED, provider: { ...CONFIGURED.provider, temperature: 0.7 } });
      const { root } = await render();
      const input = field(root, 'ai-temperature');
      expect([input.value, input.disabled, input.min, input.max]).toEqual(['0.7', false, '0', '2']);
      expect(root.querySelector('#ai-temperature-hint')).toBeNull();
    });

    it('shows the hint and empties the field when the kind changes to Anthropic, and brings the value back with OpenAI', async () => {
      setup({ ...CONFIGURED, provider: { ...CONFIGURED.provider, temperature: 0.7 } });
      const { fixture, root } = await render();
      await choose(fixture, root, 'anthropic');
      expect(field(root, 'ai-temperature').value).toBe('');
      expect(field(root, 'ai-temperature').disabled).toBe(true);
      expect(root.querySelector('#ai-temperature-hint')?.textContent?.trim()).toBe(HINT);
      await choose(fixture, root, 'openai');
      expect(field(root, 'ai-temperature').value).toBe('0.7');
      expect(root.querySelector('#ai-temperature-hint')).toBeNull();
    });

    it('sends none for an Anthropic provider, whatever was typed under another kind', async () => {
      const server = setup(CONFIGURED);
      server.on('PUT', '/api/v0/system/llm', { body: ANTHROPIC });
      const { fixture, root } = await render();
      type(root, '#ai-temperature', '0.5');
      await choose(fixture, root, 'anthropic');
      submit(root);
      await settle(fixture);
      expect(sent(server)?.provider).toMatchObject({ kind: 'anthropic', temperature: null });
    });

    it('sends the temperature of an OpenAI-compatible provider, and refuses one over 2 in the page’s words', async () => {
      const server = setup(CONFIGURED);
      server.on('PUT', '/api/v0/system/llm', { body: CONFIGURED });
      const { fixture, root } = await render();
      type(root, '#ai-temperature', '1.5');
      submit(root);
      await settle(fixture);
      expect(sent(server)?.provider).toMatchObject({ kind: 'openai', temperature: 1.5 });

      type(root, '#ai-temperature', '2.5');
      submit(root);
      await settle(fixture);
      expect(server.requestsTo('PUT', '/api/v0/system/llm')).toHaveLength(1);
      expect(root.querySelector('#ai-temperature-error')?.textContent?.trim()).toBe(
        'Use a number from 0 to 2, or leave it empty.',
      );
    });
  });
});

describe('AiSettingsPage: the OpenAI Responses API (6I-4)', () => {
  const HINT_TEXT =
    'This model takes tools only through the Responses API: choose Responses below.';
  const field = (root: HTMLElement, id: string) => root.querySelector<HTMLSelectElement>(`#${id}`)!;
  type PutBody = { provider: Record<string, unknown> };
  /** The body of the first save the page sent. */
  const sent = (server: FakeServer) =>
    server.requestsTo('PUT', '/api/v0/system/llm')[0]?.body as PutBody | undefined;
  const responses = { ...CONFIGURED, provider: { ...CONFIGURED.provider, api: 'responses' } };
  const pressTest = async (fixture: { whenStable(): Promise<unknown> }, root: HTMLElement) => {
    [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Test')!.click();
    await settle(fixture);
  };

  describe('the API', () => {
    it('is a select of an OpenAI-compatible provider, with its two APIs and its hint', async () => {
      setup(CONFIGURED);
      const { root } = await render();
      const select = field(root, 'ai-api');
      expect(root.querySelector('label[for="ai-api"]')?.textContent?.trim()).toBe('API');
      expect(root.querySelector('#ai-api-hint')?.textContent?.trim()).toBe(
        'The newest OpenAI models take tools only through the Responses API.',
      );
      expect(select.getAttribute('aria-describedby')).toBe('ai-api-hint');
      expect([...select.options].map((o) => [o.value, o.textContent?.trim()])).toEqual([
        ['chat_completions', 'Chat Completions'],
        ['responses', 'Responses'],
      ]);
      // Today's wire, unless it was chosen.
      expect(select.value).toBe('chat_completions');
    });

    it('is not a setting of an Anthropic provider, which has one API', async () => {
      setup({ ...CONFIGURED, provider: { ...CONFIGURED.provider, kind: 'anthropic' } });
      const { fixture, root } = await render();
      expect(root.querySelector('#ai-api')).toBeNull();
      type(root, '#ai-kind', 'openai');
      await settle(fixture);
      expect(root.querySelector('#ai-api')).not.toBeNull();
      type(root, '#ai-kind', 'anthropic');
      await settle(fixture);
      expect(root.querySelector('#ai-api')).toBeNull();
      expect(root.textContent).not.toContain('Chat Completions');
    });

    it('is a setting of the OpenAI kind alone: not while no kind is chosen, nor for Anthropic, as the key header, the JSON mode and the output limit field', async () => {
      setup();
      const { fixture, root } = await render();
      expect(field(root, 'ai-kind').value).toBe('');
      const OPENAI_ONLY = ['ai-api', 'ai-auth', 'ai-json', 'ai-max-tokens-field'];
      for (const id of OPENAI_ONLY) expect(root.querySelector(`#${id}`), id).toBeNull();
      for (const [kind, shown] of [
        ['openai', true],
        ['anthropic', false],
        ['', false],
        ['openai', true],
      ] as const) {
        type(root, '#ai-kind', kind);
        await settle(fixture);
        for (const id of OPENAI_ONLY) {
          expect(root.querySelector(`#${id}`) !== null, `${id}, kind ${kind || 'none'}`).toBe(
            shown,
          );
        }
      }
    });

    it('shows the stored API', async () => {
      setup(responses);
      const { root } = await render();
      expect(field(root, 'ai-api').value).toBe('responses');
    });

    it('reads a provider saved before it as Chat Completions', async () => {
      const old = Object.fromEntries(
        Object.entries(CONFIGURED.provider).filter(([name]) => name !== 'api'),
      );
      expect(old).not.toHaveProperty('api');
      setup({ ...CONFIGURED, provider: old });
      const { root } = await render();
      expect(field(root, 'ai-api').value).toBe('chat_completions');
    });

    it('sends the API that is chosen, for an OpenAI-compatible provider', async () => {
      const server = setup(CONFIGURED);
      server.on('PUT', '/api/v0/system/llm', { body: responses });
      const { fixture, root } = await render();
      submit(root);
      await settle(fixture);
      expect(sent(server)?.provider).toMatchObject({ kind: 'openai', api: 'chat_completions' });
      type(root, '#ai-api', 'responses');
      submit(root);
      await settle(fixture);
      expect(server.requestsTo('PUT', '/api/v0/system/llm')[1]?.body).toMatchObject({
        provider: { kind: 'openai', api: 'responses' },
      });
      // And back.
      type(root, '#ai-api', 'chat_completions');
      submit(root);
      await settle(fixture);
      expect(server.requestsTo('PUT', '/api/v0/system/llm')[2]?.body).toMatchObject({
        provider: { api: 'chat_completions' },
      });
    });

    it('sends none for Anthropic, whatever was chosen under OpenAI', async () => {
      const server = setup(responses);
      server.on('PUT', '/api/v0/system/llm', { body: CONFIGURED });
      const { fixture, root } = await render();
      type(root, '#ai-kind', 'anthropic');
      await settle(fixture);
      submit(root);
      await settle(fixture);
      expect(sent(server)?.provider).toMatchObject({ kind: 'anthropic' });
      expect(sent(server)?.provider).not.toHaveProperty('api');
    });

    it('takes the output limit field away while the Responses API is chosen: its limit is always max_output_tokens', async () => {
      setup(CONFIGURED);
      const { fixture, root } = await render();
      expect(root.querySelector('#ai-max-tokens-field')).not.toBeNull();
      type(root, '#ai-api', 'responses');
      await settle(fixture);
      expect(root.querySelector('#ai-max-tokens-field')).toBeNull();
      expect(root.querySelector('#ai-max-tokens-field-hint')).toBeNull();
      // The key header and the JSON mode are still the settings of this API.
      expect(root.querySelector('#ai-auth')).not.toBeNull();
      expect(root.querySelector('#ai-json')).not.toBeNull();
      type(root, '#ai-api', 'chat_completions');
      await settle(fixture);
      expect(field(root, 'ai-max-tokens-field').value).toBe('max_tokens');
    });

    it('shows none of the OpenAI rows while no kind is chosen, and brings them back as they were with OpenAI', async () => {
      setup(CONFIGURED);
      const { fixture, root } = await render();
      type(root, '#ai-api', 'responses');
      await settle(fixture);
      expect(root.querySelector('#ai-max-tokens-field')).toBeNull();
      type(root, '#ai-kind', '');
      await settle(fixture);
      for (const id of ['ai-api', 'ai-auth', 'ai-json', 'ai-max-tokens-field']) {
        expect(root.querySelector(`#${id}`), id).toBeNull();
      }
      type(root, '#ai-kind', 'openai');
      await settle(fixture);
      // As they were: the Responses API is chosen, which has no output limit field.
      expect(field(root, 'ai-api').value).toBe('responses');
      expect(root.querySelector('#ai-auth')).not.toBeNull();
      expect(root.querySelector('#ai-json')).not.toBeNull();
      expect(root.querySelector('#ai-max-tokens-field')).toBeNull();
    });

    it('keeps the output limit field the admin set, and sends it, while another API is chosen', async () => {
      const server = setup(CONFIGURED);
      server.on('PUT', '/api/v0/system/llm', { body: CONFIGURED });
      const { fixture, root } = await render();
      type(root, '#ai-max-tokens-field', 'max_completion_tokens');
      type(root, '#ai-api', 'responses');
      await settle(fixture);
      // The field comes back as it was left.
      type(root, '#ai-api', 'chat_completions');
      await settle(fixture);
      expect(field(root, 'ai-max-tokens-field').value).toBe('max_completion_tokens');
      type(root, '#ai-api', 'responses');
      await settle(fixture);
      submit(root);
      await settle(fixture);
      expect(sent(server)?.provider).toMatchObject({
        api: 'responses',
        maxTokensField: 'max_completion_tokens',
      });
    });
  });

  describe('the Test suggests the Responses API', () => {
    const needsResponses = {
      code: 'USE_RESPONSES_API',
      message: 'server text',
    } as const;

    it('says so beside the tool calling of a model that refused tools through Chat Completions, in the page’s words', async () => {
      const server = setup(CONFIGURED);
      server.on('POST', '/api/v0/system/llm/test', {
        body: testAnswer({
          ok: true,
          model: 'qwen2.5-coder',
          latencyMs: 12,
          toolCalling: 'not_supported',
          problem: null,
          hint: needsResponses,
        }),
      });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      const status = root.querySelector('[role="status"]')!;
      expect(status.querySelector('#ai-test-tools')?.textContent?.trim()).toBe(
        'Tool calling (needed by AI review): not supported',
      );
      const hint = status.querySelector('#ai-test-use-responses')!;
      expect(hint.textContent?.trim()).toBe(HINT_TEXT);
      expect(hint.classList).toContain('alert-warn');
      // The choice it names is on the page, below the message.
      expect(
        hint.compareDocumentPosition(field(root, 'ai-api')) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(root.textContent).not.toContain('server text');
      expect(root.querySelector('.alert-error')).toBeNull();
    });

    it('says nothing of it for a model that passed, or that was refused for another reason', async () => {
      const server = setup(CONFIGURED);
      server.on('POST', '/api/v0/system/llm/test', {
        body: testAnswer({
          ok: true,
          model: 'qwen2.5-coder',
          latencyMs: 12,
          toolCalling: 'not_supported',
          problem: null,
        }),
      });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(root.querySelector('#ai-test-tools')).not.toBeNull();
      expect(root.querySelector('#ai-test-use-responses')).toBeNull();
      expect(root.textContent).not.toContain(HINT_TEXT);
    });

    it('forgets the hint when the page does anything else', async () => {
      const server = setup(CONFIGURED);
      server.on('POST', '/api/v0/system/llm/test', {
        body: testAnswer({
          ok: true,
          model: 'qwen2.5-coder',
          latencyMs: 12,
          toolCalling: 'not_supported',
          problem: null,
          hint: needsResponses,
        }),
      });
      server.on('PUT', '/api/v0/system/llm', { body: responses });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(root.querySelector('#ai-test-use-responses')).not.toBeNull();
      type(root, '#ai-api', 'responses');
      submit(root);
      await settle(fixture);
      expect(root.querySelector('#ai-test-use-responses')).toBeNull();
      expect(root.querySelector('#ai-test-tools')).toBeNull();
    });

    it('is said on the line of the model that needs it, in a Test of several models', async () => {
      const server = setup({
        ...CONFIGURED,
        provider: { ...CONFIGURED.provider, strongModel: 'qwen3-max' },
      });
      const line = (
        tier: 'standard' | 'strong',
        model: string,
        over: Partial<TestAnswer['models'][number]> = {},
      ): TestAnswer['models'][number] => ({
        tier,
        model,
        ok: true,
        reportedModel: `reported-${model}`,
        latencyMs: 12,
        toolCalling: 'supported',
        problem: null,
        hint: null,
        ...over,
      });
      const standard = line('standard', 'qwen2.5-coder');
      server.on('POST', '/api/v0/system/llm/test', {
        body: {
          ok: true,
          model: standard.reportedModel,
          latencyMs: 12,
          toolCalling: 'supported',
          problem: null,
          hint: null,
          models: [
            standard,
            line('strong', 'qwen3-max', { toolCalling: 'not_supported', hint: needsResponses }),
          ],
        } satisfies TestAnswer,
      });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      const lines = [...root.querySelectorAll('#ai-test-models li')].map((li) => ({
        text: li.textContent?.trim(),
        tone: ['alert-success', 'alert-warn', 'alert-error'].find((c) => li.classList.contains(c)),
      }));
      expect(lines).toEqual([
        {
          text: 'qwen2.5-coder: connected in 12 ms · tool calling supported',
          tone: 'alert-success',
        },
        {
          text: `qwen3-max: connected in 12 ms · tool calling not supported · ${HINT_TEXT}`,
          tone: 'alert-warn',
        },
      ]);
      expect(root.querySelector('#ai-test-use-responses')).toBeNull();
      expect(root.textContent).not.toContain('server text');
    });
  });
});
