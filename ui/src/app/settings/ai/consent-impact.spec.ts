import { CONFIGURED, organizationsFixture } from '../../../testing/ai-settings';
import { ORG_ID } from '../../../testing/fake-server';
import type { Organization, ResponseBody } from '../../api/types';
import {
  type ConsentInput,
  consentFields,
  pausesReview,
  reviewingOrganizations,
  unnamedReviewing,
} from './consent-impact';

type LlmSettings = ResponseBody<'/api/v0/system/llm', 'get'>;
type Provider = NonNullable<LlmSettings['provider']>;

/** An Ollama provider with a model of each tier. */
const SAVED: Provider = {
  ...(CONFIGURED.provider as Provider),
  strongModel: 'qwen-strong',
  fastModel: 'qwen-fast',
};

/** What a confirmation names of a provider: its address and models, nothing else. */
const consentOf = (p: Provider): ConsentInput => ({
  baseUrl: p.baseUrl,
  model: p.model,
  strongModel: p.strongModel,
  fastModel: p.fastModel,
});

describe('consentFields', () => {
  it('names the address as the server keeps it, its host, and each model once, sorted', () => {
    expect(
      consentFields({
        baseUrl: '  HTTP://Ollama:11434/v1/  ',
        model: ' qwen2.5-coder ',
        strongModel: 'qwen-strong',
        fastModel: 'qwen2.5-coder',
      }),
    ).toEqual({
      url: 'http://ollama:11434/v1',
      host: 'ollama:11434',
      model: 'qwen2.5-coder',
      models: ['qwen-strong', 'qwen2.5-coder'],
    });
  });

  it('counts an empty tier as the standard model, as the body sends it', () => {
    const fields = consentFields({
      baseUrl: 'https://api.openai.com/v1',
      model: 'm',
      strongModel: '',
      fastModel: null,
    });
    expect(fields.models).toEqual(['m']);
  });

  it('throws for an address that does not parse', () => {
    expect(() =>
      consentFields({ baseUrl: 'ollama', model: 'm', strongModel: null, fastModel: null }),
    ).toThrow();
  });
});

describe('pausesReview', () => {
  /** The saved provider without models of its own for the tiers. */
  const ONE_MODEL: Provider = { ...SAVED, strongModel: null, fastModel: null };

  it.each<[string, Provider, Partial<Provider>]>([
    ['a change of the path', SAVED, { baseUrl: 'http://ollama:11434/api/v1' }],
    ['a change of the host', SAVED, { baseUrl: 'http://vllm:8000/v1' }],
    ['a change of the standard model', SAVED, { model: 'qwen3-coder' }],
    ['a tier added', ONE_MODEL, { strongModel: 'qwen-strong' }],
    ['a tier removed', SAVED, { fastModel: null }],
    ["a tier's model swapped for another", SAVED, { strongModel: 'qwen-max' }],
  ])('pauses for %s', (_what, saved, change) => {
    expect(pausesReview(saved, consentOf({ ...saved, ...change }))).toBe(true);
  });

  it.each<[string, Provider, Partial<Provider>]>([
    ['the key set again', SAVED, { apiKeySet: true, apiKeyReadable: false }],
    ['the timeout', SAVED, { timeoutSeconds: 120 }],
    ['the API', SAVED, { api: 'responses' }],
    ['the workspace', SAVED, { workspaceId: 'wrkspc_01AbCd' }],
    ['the temperature', SAVED, { temperature: 0.4 }],
    ['the key header and the JSON mode', SAVED, { auth: 'api-key', jsonMode: 'none' }],
    ['a trailing slash on the address', SAVED, { baseUrl: 'http://ollama:11434/v1/' }],
    // The confirmation names the set of models, whichever tier uses each.
    [
      'the strong and the fast model trading places',
      SAVED,
      { strongModel: 'qwen-fast', fastModel: 'qwen-strong' },
    ],
    ['a tier given the standard model', ONE_MODEL, { fastModel: 'qwen2.5-coder' }],
  ])('does not pause for %s', (_what, saved, change) => {
    expect(pausesReview(saved, consentOf({ ...saved, ...change }))).toBe(false);
  });

  it('pauses for the removal of a saved provider, and nothing without one', () => {
    expect(pausesReview(SAVED, null)).toBe(true);
    expect(pausesReview(null, null)).toBe(false);
    expect(pausesReview(null, consentOf(SAVED))).toBe(false);
  });

  it('pauses nothing for an address that does not parse: the page refuses it first', () => {
    expect(pausesReview(SAVED, { ...consentOf(SAVED), baseUrl: 'ollama' })).toBe(false);
  });
});

describe('reviewingOrganizations', () => {
  const [acme, research, lab] = organizationsFixture(3) as [
    Organization,
    Organization,
    Organization,
  ];
  const status = (enabled: boolean, consentCurrent: boolean) => ({
    ...CONFIGURED.organizations[ORG_ID],
    reviewStatus: { enabled, consentCurrent },
  });

  it('names the organisations whose review is on and confirmed for this provider, in their order', () => {
    const settings = {
      ...CONFIGURED,
      organizations: {
        [lab.id]: status(true, true),
        [acme.id]: status(true, true),
        // On, but paused already: a change pauses nothing more.
        [research.id]: status(true, false),
      },
    } as unknown as LlmSettings;
    expect(reviewingOrganizations(settings, [acme, research, lab])).toEqual([
      { id: acme.id, name: acme.name },
      { id: lab.id, name: lab.name },
    ]);
  });

  it('names none whose review is off, nor one the settings do not hold', () => {
    const settings = {
      ...CONFIGURED,
      organizations: { [acme.id]: status(false, true) },
    } as unknown as LlmSettings;
    expect(reviewingOrganizations(settings, [acme, research])).toEqual([]);
  });

  it('names none that may not use AI, whatever its admins switched on', () => {
    const settings = {
      ...CONFIGURED,
      organizations: {
        [acme.id]: status(true, true),
        [research.id]: { ...status(true, true), enabled: false },
      },
    } as unknown as LlmSettings;
    expect(reviewingOrganizations(settings, [acme, research])).toEqual([
      { id: acme.id, name: acme.name },
    ]);
  });
});

describe('unnamedReviewing', () => {
  const [acme, research] = organizationsFixture(2) as [Organization, Organization];
  const status = (enabled: boolean, consentCurrent: boolean) => ({
    ...CONFIGURED.organizations[ORG_ID],
    reviewStatus: { enabled, consentCurrent },
  });

  it('counts the organisations a change pauses that the list does not name', () => {
    const settings = {
      ...CONFIGURED,
      organizations: {
        [acme.id]: status(true, true),
        [research.id]: status(true, true),
        [ORG_ID]: status(true, false),
      },
    } as unknown as LlmSettings;
    // The list could not be read: all of them.
    expect(unnamedReviewing(settings, [])).toBe(2);
    // It names Acme: one more.
    expect(unnamedReviewing(settings, [acme])).toBe(1);
    expect(unnamedReviewing(settings, [acme, research])).toBe(0);
  });

  it('counts none that may not use AI, whatever its admins switched on', () => {
    const settings = {
      ...CONFIGURED,
      organizations: {
        [acme.id]: status(true, true),
        [research.id]: { ...status(true, true), enabled: false },
      },
    } as unknown as LlmSettings;
    expect(unnamedReviewing(settings, [])).toBe(1);
  });
});
