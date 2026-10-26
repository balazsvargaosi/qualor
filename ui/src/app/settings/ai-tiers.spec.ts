import {
  CONFIGURED,
  EMPTY,
  render,
  setup,
  submit,
  type,
  type TestAnswer,
} from '../../testing/ai-settings';
import type { FakeServer } from '../../testing/fake-server';
import { problem, settle } from '../../testing/fake-server';

describe('AiSettingsPage: the models of the tiers (6I-4)', () => {
  const PRICES = { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2 };
  const STRONG_PRICES = { inputUsdPerMTok: 2, outputUsdPerMTok: 8 };
  const FAST_PRICES = { inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.4 };
  /** A provider with a model of each tier, and the prices of the three. */
  const THREE_MODELS = {
    ...CONFIGURED,
    provider: { ...CONFIGURED.provider, strongModel: 'qwen3-max', fastModel: 'qwen2.5-small' },
    pricing: { ...PRICES, strong: STRONG_PRICES, fast: FAST_PRICES },
  };
  const field = (root: HTMLElement, id: string) => root.querySelector<HTMLInputElement>(`#${id}`)!;
  const labelOf = (root: HTMLElement, id: string) =>
    root.querySelector(`label[for="${id}"]`)?.textContent?.trim();
  /** The ids of the price fields, in the page's order. */
  const priceIds = (root: HTMLElement) =>
    [...root.querySelectorAll('input[id^="ai-price-"]')].map((input) => input.id);
  type PutBody = { provider: Record<string, unknown>; pricing: Record<string, unknown> | null };
  /** The body of the first save the page sent. */
  const sent = (server: FakeServer) =>
    server.requestsTo('PUT', '/api/v0/system/llm')[0]?.body as PutBody | undefined;

  describe('the fields', () => {
    it('has an optional Strong model and an optional Fast model, right after Model, with their hints', async () => {
      setup(CONFIGURED);
      const { root } = await render();
      expect(labelOf(root, 'ai-strong-model')).toBe('Strong model');
      expect(labelOf(root, 'ai-fast-model')).toBe('Fast model');
      expect(root.querySelector('#ai-strong-model-hint')?.textContent?.trim()).toBe(
        'Used for the judge and the security checks. Empty: the model above.',
      );
      expect(root.querySelector('#ai-fast-model-hint')?.textContent?.trim()).toBe(
        'Used for small reviews. Empty: the model above.',
      );
      for (const id of ['ai-strong-model', 'ai-fast-model']) {
        const input = field(root, id);
        // As Model: a text of at most 200 characters; optional, so empty is fine.
        expect([input.type, input.maxLength, input.value, input.required]).toEqual([
          'text',
          200,
          '',
          false,
        ]);
        expect(input.getAttribute('aria-describedby')).toBe(`${id}-hint`);
        expect(input.getAttribute('aria-invalid')).toBeNull();
      }
      // The rows follow Model's, in that order.
      const row = (id: string) => field(root, id).closest('.setting-row');
      expect(row('ai-model')?.nextElementSibling).toBe(row('ai-strong-model'));
      expect(row('ai-strong-model')?.nextElementSibling).toBe(row('ai-fast-model'));
      expect(row('ai-fast-model')?.nextElementSibling).toBe(row('ai-key'));
    });

    it('shows the stored tier models', async () => {
      setup(THREE_MODELS);
      const { root } = await render();
      expect(field(root, 'ai-model').value).toBe('qwen2.5-coder');
      expect(field(root, 'ai-strong-model').value).toBe('qwen3-max');
      expect(field(root, 'ai-fast-model').value).toBe('qwen2.5-small');
    });

    it('sends an empty tier model as null, and a typed one trimmed', async () => {
      const server = setup(CONFIGURED);
      server.on('PUT', '/api/v0/system/llm', { body: CONFIGURED });
      const { fixture, root } = await render();
      submit(root);
      await settle(fixture);
      expect(sent(server)?.provider).toMatchObject({ strongModel: null, fastModel: null });

      type(root, '#ai-strong-model', '  qwen3-max ');
      submit(root);
      await settle(fixture);
      expect(server.requestsTo('PUT', '/api/v0/system/llm')[1]?.body).toMatchObject({
        provider: { model: 'qwen2.5-coder', strongModel: 'qwen3-max', fastModel: null },
      });
    });

    it('takes a tier model back to null when its field is emptied', async () => {
      const server = setup(THREE_MODELS);
      server.on('PUT', '/api/v0/system/llm', { body: THREE_MODELS });
      const { fixture, root } = await render();
      type(root, '#ai-fast-model', '');
      submit(root);
      await settle(fixture);
      expect(sent(server)?.provider).toMatchObject({ strongModel: 'qwen3-max', fastModel: null });
    });

    it.each([['strong'], ['fast']] as const)(
      'refuses a %s model that is not a model name on its own field, and sends nothing',
      async (tier) => {
        const server = setup(CONFIGURED);
        const { fixture, root } = await render();
        const id = `ai-${tier}-model`;
        type(root, `#${id}`, 'two words');
        submit(root);
        await settle(fixture);
        expect(server.requestsTo('PUT', '/api/v0/system/llm')).toHaveLength(0);
        expect(field(root, id).getAttribute('aria-invalid')).toBe('true');
        expect(root.querySelector(`#${id}-error`)?.textContent).toContain(
          "Use the model's name as the provider spells it",
        );
        expect(field(root, id).getAttribute('aria-describedby')).toBe(`${id}-error ${id}-hint`);
        expect(document.activeElement).toBe(field(root, id));
        // Typing again takes the refusal back.
        type(root, `#${id}`, 'qwen3-max');
        await settle(fixture);
        expect(root.querySelector(`#${id}-error`)).toBeNull();
        expect(field(root, id).getAttribute('aria-invalid')).toBeNull();
      },
    );

    it.each([
      ['body.provider.strongModel', 'ai-strong-model'],
      ['body.provider.fastModel', 'ai-fast-model'],
    ])('maps the server’s refusal at %s to its field, in the page’s words', async (path, id) => {
      const server = setup(CONFIGURED);
      server.on('PUT', '/api/v0/system/llm', {
        status: 422,
        body: problem(422, 'VALIDATION_FAILED', [{ path, message: 'server text' }]),
      });
      const { fixture, root } = await render();
      submit(root);
      await settle(fixture);
      expect(field(root, id).getAttribute('aria-invalid')).toBe('true');
      expect(root.querySelector(`#${id}-error`)?.textContent).toContain(
        "Use the model's name as the provider spells it",
      );
      expect(root.textContent).not.toContain('server text');
      expect(root.querySelector('.alert-error')).toBeNull();
    });
  });

  describe('the prices', () => {
    it('shows the price fields of a tier only while it has a model of its own', async () => {
      setup(CONFIGURED);
      const { fixture, root } = await render();
      expect(priceIds(root)).toEqual(['ai-price-input', 'ai-price-output']);

      type(root, '#ai-strong-model', 'qwen3-max');
      await settle(fixture);
      expect(priceIds(root)).toEqual([
        'ai-price-input',
        'ai-price-output',
        'ai-price-strong-input',
        'ai-price-strong-output',
      ]);
      type(root, '#ai-fast-model', 'qwen2.5-small');
      await settle(fixture);
      expect(priceIds(root)).toEqual([
        'ai-price-input',
        'ai-price-output',
        'ai-price-strong-input',
        'ai-price-strong-output',
        'ai-price-fast-input',
        'ai-price-fast-output',
      ]);
      // The same model as Model is no model of its own: the standard prices are its prices.
      type(root, '#ai-fast-model', ' qwen2.5-coder ');
      await settle(fixture);
      expect(priceIds(root)).toEqual([
        'ai-price-input',
        'ai-price-output',
        'ai-price-strong-input',
        'ai-price-strong-output',
      ]);
      // Emptied, and a tier that now has the model above, have none either.
      type(root, '#ai-strong-model', '');
      type(root, '#ai-model', 'qwen2.5-small');
      type(root, '#ai-fast-model', 'qwen2.5-small');
      await settle(fixture);
      expect(priceIds(root)).toEqual(['ai-price-input', 'ai-price-output']);
    });

    it('names each price after its model, and puts them after the two prices', async () => {
      setup(THREE_MODELS);
      const { root } = await render();
      const unit = '(US dollars per million tokens)';
      expect(labelOf(root, 'ai-price-input')).toBe(`Input price ${unit}`);
      expect(labelOf(root, 'ai-price-strong-input')).toBe(`Strong model: input price ${unit}`);
      expect(labelOf(root, 'ai-price-strong-output')).toBe(`Strong model: output price ${unit}`);
      expect(labelOf(root, 'ai-price-fast-input')).toBe(`Fast model: input price ${unit}`);
      expect(labelOf(root, 'ai-price-fast-output')).toBe(`Fast model: output price ${unit}`);
      expect(priceIds(root)).toEqual([
        'ai-price-input',
        'ai-price-output',
        'ai-price-strong-input',
        'ai-price-strong-output',
        'ai-price-fast-input',
        'ai-price-fast-output',
      ]);
      // As the standard prices: numbers from 0 to 10 000.
      for (const id of priceIds(root)) {
        const input = field(root, id);
        expect([input.type, input.min, input.max, input.step]).toEqual([
          'number',
          '0',
          '10000',
          '0.01',
        ]);
      }
    });

    it('shows the stored prices of the tiers', async () => {
      setup(THREE_MODELS);
      const { root } = await render();
      expect(priceIds(root).map((id) => [id, field(root, id).value])).toEqual([
        ['ai-price-input', '0.3'],
        ['ai-price-output', '1.2'],
        ['ai-price-strong-input', '2'],
        ['ai-price-strong-output', '8'],
        ['ai-price-fast-input', '0.1'],
        ['ai-price-fast-output', '0.4'],
      ]);
    });

    it('sends the prices of the tiers with the standard ones, and none for a tier without a model of its own', async () => {
      const server = setup(CONFIGURED);
      server.on('PUT', '/api/v0/system/llm', { body: CONFIGURED });
      const { fixture, root } = await render();
      type(root, '#ai-price-input', '0.3');
      type(root, '#ai-price-output', '1.2');
      submit(root);
      await settle(fixture);
      // A tier that has no model of its own sends null: the server prices it at the standard prices.
      expect(sent(server)?.pricing).toEqual({ ...PRICES, strong: null, fast: null });

      type(root, '#ai-price-input', '0.3');
      type(root, '#ai-price-output', '1.2');
      type(root, '#ai-strong-model', 'qwen3-max');
      await settle(fixture);
      type(root, '#ai-price-strong-input', '2');
      type(root, '#ai-price-strong-output', '8');
      submit(root);
      await settle(fixture);
      expect((server.requestsTo('PUT', '/api/v0/system/llm')[1]?.body as PutBody).pricing).toEqual({
        ...PRICES,
        strong: STRONG_PRICES,
        fast: null,
      });
    });

    it('sends every pair of three models, and no price of a tier whose model was taken away', async () => {
      const server = setup(THREE_MODELS);
      server.on('PUT', '/api/v0/system/llm', { body: THREE_MODELS });
      const { fixture, root } = await render();
      submit(root);
      await settle(fixture);
      expect(sent(server)?.pricing).toEqual({
        ...PRICES,
        strong: STRONG_PRICES,
        fast: FAST_PRICES,
      });
      // The prices typed for a tier stay in their fields, but go only while it has a model.
      type(root, '#ai-fast-model', '');
      submit(root);
      await settle(fixture);
      expect((server.requestsTo('PUT', '/api/v0/system/llm')[1]?.body as PutBody).pricing).toEqual({
        ...PRICES,
        strong: STRONG_PRICES,
        fast: null,
      });
    });

    it('sends no prices at all when none is given, whatever the models', async () => {
      const server = setup(THREE_MODELS);
      server.on('PUT', '/api/v0/system/llm', { body: THREE_MODELS });
      const { fixture, root } = await render();
      for (const id of priceIds(root)) type(root, `#${id}`, '');
      submit(root);
      await settle(fixture);
      expect(sent(server)).toMatchObject({ pricing: null });
    });

    it('shows no price of a tier and sends none while the kind is None: the assistant switches off', async () => {
      const server = setup(THREE_MODELS);
      server.on('PUT', '/api/v0/system/llm', { body: { ...THREE_MODELS, provider: null } });
      const { fixture, root } = await render();
      expect(priceIds(root)).toHaveLength(6);
      type(root, '#ai-kind', '');
      await settle(fixture);
      // Without a provider no tier has a model, so none has prices of its own.
      expect(priceIds(root)).toEqual(['ai-price-input', 'ai-price-output']);
      submit(root);
      await settle(fixture);
      expect(sent(server)?.provider).toBeNull();
      expect(sent(server)?.pricing).toEqual({ ...PRICES, strong: null, fast: null });
      // Saved: no field refused, no alert.
      expect(root.querySelector('[aria-invalid="true"]')).toBeNull();
      expect(root.querySelector('.field-error')).toBeNull();
      expect(root.querySelector('[role="alert"]')).toBeNull();
      expect(root.querySelector('[role="status"]')?.textContent).toContain(
        'The AI assistant settings were saved.',
      );
    });

    it('shows no price of a tier before a kind is chosen, whatever models are typed', async () => {
      setup(EMPTY);
      const { fixture, root } = await render();
      type(root, '#ai-model', 'qwen2.5-coder');
      type(root, '#ai-strong-model', 'qwen3-max');
      type(root, '#ai-fast-model', 'qwen2.5-small');
      await settle(fixture);
      expect(priceIds(root)).toEqual(['ai-price-input', 'ai-price-output']);
      type(root, '#ai-kind', 'openai');
      await settle(fixture);
      expect(priceIds(root)).toHaveLength(6);
    });

    it('brings the prices of a tier back, as they were typed, when a kind is chosen again', async () => {
      setup(THREE_MODELS);
      const { fixture, root } = await render();
      type(root, '#ai-kind', '');
      await settle(fixture);
      expect(priceIds(root)).toHaveLength(2);
      type(root, '#ai-kind', 'anthropic');
      await settle(fixture);
      expect(priceIds(root).map((id) => [id, field(root, id).value])).toEqual([
        ['ai-price-input', '0.3'],
        ['ai-price-output', '1.2'],
        ['ai-price-strong-input', '2'],
        ['ai-price-strong-output', '8'],
        ['ai-price-fast-input', '0.1'],
        ['ai-price-fast-output', '0.4'],
      ]);
    });

    it.each([
      ['strong', "Give the strong model's prices too"],
      ['fast', "Give the fast model's prices too"],
    ] as const)(
      'refuses prices given without those of the %s model, on its fields, and sends nothing',
      async (tier, text) => {
        const server = setup(THREE_MODELS);
        const { fixture, root } = await render();
        type(root, `#ai-price-${tier}-input`, '');
        type(root, `#ai-price-${tier}-output`, '');
        submit(root);
        await settle(fixture);
        expect(server.requestsTo('PUT', '/api/v0/system/llm')).toHaveLength(0);
        for (const side of ['input', 'output']) {
          const id = `ai-price-${tier}-${side}`;
          expect(field(root, id).getAttribute('aria-invalid')).toBe('true');
          expect(root.querySelector(`#${id}-error`)?.textContent).toContain(text);
          expect(field(root, id).getAttribute('aria-describedby')).toBe(`${id}-error`);
        }
        // The other tier's fields are fine, and so are the standard ones.
        const other = tier === 'strong' ? 'fast' : 'strong';
        expect(field(root, `ai-price-${other}-input`).getAttribute('aria-invalid')).toBeNull();
        expect(field(root, 'ai-price-input').getAttribute('aria-invalid')).toBeNull();
        expect(document.activeElement).toBe(field(root, `ai-price-${tier}-input`));
        // Typing a price takes that field's refusal back.
        type(root, `#ai-price-${tier}-input`, '1');
        await settle(fixture);
        expect(root.querySelector(`#ai-price-${tier}-input-error`)).toBeNull();
      },
    );

    it('refuses a price of a tier outside 0 to 10 000, in the same words', async () => {
      const server = setup(THREE_MODELS);
      const { fixture, root } = await render();
      type(root, '#ai-price-strong-output', '10001');
      submit(root);
      await settle(fixture);
      expect(server.requestsTo('PUT', '/api/v0/system/llm')).toHaveLength(0);
      expect(root.querySelector('#ai-price-strong-output-error')?.textContent).toContain(
        'in US dollars per million tokens (0 to 10000)',
      );
    });

    it('asks for the standard prices when only a tier’s are typed', async () => {
      const server = setup({ ...THREE_MODELS, pricing: null });
      const { fixture, root } = await render();
      type(root, '#ai-price-strong-input', '2');
      type(root, '#ai-price-strong-output', '8');
      submit(root);
      await settle(fixture);
      expect(server.requestsTo('PUT', '/api/v0/system/llm')).toHaveLength(0);
      // The prices of the model above are the pair the others need.
      expect(field(root, 'ai-price-input').getAttribute('aria-invalid')).toBe('true');
      expect(field(root, 'ai-price-output').getAttribute('aria-invalid')).toBe('true');
      expect(root.querySelector('#ai-price-input-error')?.textContent).toContain(
        'Give both prices',
      );
      expect(document.activeElement).toBe(field(root, 'ai-price-input'));
    });

    it.each([
      ['body.pricing.strong', 'ai-price-strong-input'],
      ['body.pricing.strong.inputUsdPerMTok', 'ai-price-strong-input'],
      ['body.pricing.strong.outputUsdPerMTok', 'ai-price-strong-output'],
      ['body.pricing.fast', 'ai-price-fast-input'],
      ['body.pricing.fast.inputUsdPerMTok', 'ai-price-fast-input'],
      ['body.pricing.fast.outputUsdPerMTok', 'ai-price-fast-output'],
      ['body.pricing.outputUsdPerMTok', 'ai-price-output'],
      ['body.pricing', 'ai-price-input'],
    ])('maps the server’s refusal at %s to %s', async (path, id) => {
      const server = setup(THREE_MODELS);
      server.on('PUT', '/api/v0/system/llm', {
        status: 422,
        body: problem(422, 'VALIDATION_FAILED', [{ path, message: 'server text' }]),
      });
      const { fixture, root } = await render();
      submit(root);
      await settle(fixture);
      expect(field(root, id).getAttribute('aria-invalid')).toBe('true');
      // Only that field is marked.
      expect(
        priceIds(root).filter((other) => field(root, other).getAttribute('aria-invalid')),
      ).toEqual([id]);
      expect(root.textContent).not.toContain('server text');
    });
  });

  describe('the Test of several models', () => {
    const lines = (root: HTMLElement) =>
      [...root.querySelectorAll('#ai-test-models li')].map((li) => ({
        text: li.textContent?.trim(),
        tone: ['alert-success', 'alert-warn', 'alert-error'].find((c) => li.classList.contains(c)),
      }));
    const line = (
      tier: 'standard' | 'strong' | 'fast',
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
    /** A Test answer of several models: its own fields are those of the first, the standard model. */
    const answer = (
      standard: TestAnswer['models'][number],
      ...others: TestAnswer['models']
    ): TestAnswer => ({
      ok: standard.ok,
      model: standard.reportedModel,
      latencyMs: standard.latencyMs,
      toolCalling: standard.toolCalling,
      problem: standard.problem,
      hint: standard.hint,
      models: [standard, ...others],
    });
    const pressTest = async (fixture: { whenStable(): Promise<unknown> }, root: HTMLElement) => {
      [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Test')!.click();
      await settle(fixture);
    };

    it('shows a line for each model, in the answer’s order, with the tool calling of each', async () => {
      const server = setup(THREE_MODELS);
      server.on('POST', '/api/v0/system/llm/test', {
        body: answer(
          line('standard', 'qwen2.5-coder', { latencyMs: 120 }),
          line('strong', 'qwen3-max', { latencyMs: 640, toolCalling: 'not_supported' }),
          line('fast', 'qwen2.5-small', { latencyMs: 35, toolCalling: 'not_checked' }),
        ),
      });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(lines(root)).toEqual([
        {
          text: 'qwen2.5-coder: connected in 120 ms · tool calling supported',
          tone: 'alert-success',
        },
        {
          text: 'qwen3-max: connected in 640 ms · tool calling not supported',
          tone: 'alert-warn',
        },
        { text: 'qwen2.5-small: connected in 35 ms', tone: 'alert-success' },
      ]);
      // In the live region, a list of its own: not the single-model lines.
      expect(root.querySelector('[role="status"] ul#ai-test-models')).not.toBeNull();
      expect(root.querySelector('#ai-test-tools')).toBeNull();
      expect(root.querySelector('[role="status"] > .alert')).toBeNull();
      expect(root.textContent).not.toContain('Connected to');
      expect(root.querySelector('.alert-error')).toBeNull();
      // A tool check that did not pass, or could not tell, is not a failed Test: nothing is alerted.
      expect(root.querySelector('[role="alert"]')).toBeNull();
    });

    it('shows a model that failed as its problem in the page’s words, beside the lines of the others', async () => {
      const server = setup(THREE_MODELS);
      server.on('POST', '/api/v0/system/llm/test', {
        body: answer(
          line('standard', 'qwen2.5-coder'),
          line('strong', 'qwen3-max'),
          line('fast', 'qwen2.5-small', {
            ok: false,
            reportedModel: null,
            toolCalling: 'not_checked',
            problem: {
              code: 'PROVIDER_REJECTED_REQUEST',
              message: 'server text',
              providerStatus: 404,
            },
          }),
        ),
      });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(lines(root)).toEqual([
        {
          text: 'qwen2.5-coder: connected in 12 ms · tool calling supported',
          tone: 'alert-success',
        },
        {
          text: 'qwen3-max: connected in 12 ms · tool calling supported',
          tone: 'alert-success',
        },
        {
          text: 'qwen2.5-small: The provider refused the request; check the base URL and the model.',
          tone: 'alert-error',
        },
      ]);
      expect(root.textContent).not.toContain('server text');
      // One alert outside the list says how many failed; the lines stay in the live region.
      const alerts = root.querySelectorAll('[role="alert"]');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.textContent?.trim()).toBe('The test failed for 1 of 3 models.');
      expect(alerts[0]?.classList).toContain('alert-error');
      expect(alerts[0]?.closest('[role="status"]')).toBeNull();
      expect(root.querySelector('[role="status"] #ai-test-models')).not.toBeNull();
    });

    it('tells a refused key apart by the provider status on the line of the model', async () => {
      const server = setup(THREE_MODELS);
      const refused = (status: number) =>
        line('strong', 'qwen3-max', {
          ok: false,
          reportedModel: null,
          toolCalling: 'not_checked',
          problem: { code: 'PROVIDER_REFUSED_KEY', message: 'server text', providerStatus: status },
        });
      server.on('POST', '/api/v0/system/llm/test', {
        body: answer(line('standard', 'qwen2.5-coder'), refused(403)),
      });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(lines(root)[1]?.text).toBe(
        'qwen3-max: The provider refused the request (HTTP 403): the key lacks access to this model, or the account has no credit.',
      );
    });

    it('shows every line as a problem when the key cannot be read', async () => {
      const server = setup(THREE_MODELS);
      const problemLine = (tier: 'standard' | 'strong' | 'fast', model: string) =>
        line(tier, model, {
          ok: false,
          reportedModel: null,
          latencyMs: 0,
          toolCalling: 'not_checked',
          problem: { code: 'KEY_UNDECRYPTABLE', message: 'server text', providerStatus: null },
        });
      server.on('POST', '/api/v0/system/llm/test', {
        body: answer(
          problemLine('standard', 'qwen2.5-coder'),
          problemLine('strong', 'qwen3-max'),
          problemLine('fast', 'qwen2.5-small'),
        ),
      });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(lines(root).map((l) => l.tone)).toEqual(['alert-error', 'alert-error', 'alert-error']);
      expect(lines(root)[0]?.text).toBe(
        'qwen2.5-coder: The stored API key can no longer be read; set it again.',
      );
      expect(root.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
        'The test failed for 3 of 3 models.',
      );
    });

    it('forgets the summary of a failed Test with the lines when the page does anything else', async () => {
      const server = setup(THREE_MODELS);
      server.on('POST', '/api/v0/system/llm/test', {
        body: answer(
          line('standard', 'qwen2.5-coder'),
          line('strong', 'qwen3-max', {
            ok: false,
            reportedModel: null,
            toolCalling: 'not_checked',
            problem: { code: 'PROVIDER_TIMEOUT', message: 'server text', providerStatus: null },
          }),
        ),
      });
      server.on('PUT', '/api/v0/system/llm', { body: THREE_MODELS });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(root.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
        'The test failed for 1 of 2 models.',
      );
      submit(root);
      await settle(fixture);
      expect(root.querySelector('[role="alert"]')).toBeNull();
      expect(root.querySelector('#ai-test-models')).toBeNull();
    });

    it('shows a Test of one model as it did before the tiers: no list', async () => {
      const server = setup(CONFIGURED);
      server.on('POST', '/api/v0/system/llm/test', {
        body: answer(line('standard', 'qwen2.5-coder', { reportedModel: 'qwen2.5-coder' })),
      });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(root.querySelector('#ai-test-models')).toBeNull();
      expect(root.querySelector('[role="status"] .alert-success')?.textContent).toContain(
        'Connected to qwen2.5-coder in 12 ms.',
      );
      expect(root.querySelector('#ai-test-tools')?.textContent?.trim()).toBe(
        'Tool calling (needed by AI review): supported',
      );
    });

    it('forgets the lines when the page does anything else', async () => {
      const server = setup(THREE_MODELS);
      server.on('POST', '/api/v0/system/llm/test', {
        body: answer(line('standard', 'qwen2.5-coder'), line('strong', 'qwen3-max')),
      });
      server.on('PUT', '/api/v0/system/llm', { body: THREE_MODELS });
      const { fixture, root } = await render();
      await pressTest(fixture, root);
      expect(root.querySelectorAll('#ai-test-models li')).toHaveLength(2);
      submit(root);
      await settle(fixture);
      expect(root.querySelector('#ai-test-models')).toBeNull();
      // A new Test replaces the lines of the last one.
      await pressTest(fixture, root);
      await pressTest(fixture, root);
      expect(root.querySelectorAll('#ai-test-models li')).toHaveLength(2);
    });
  });
});
