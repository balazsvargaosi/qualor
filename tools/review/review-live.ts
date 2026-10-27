import { isIP } from 'node:net';
import {
  converse,
  LlmError,
  PROVIDER_APIS,
  PROVIDER_KINDS,
  type LlmConversation,
  type LlmTurn,
  type ProviderApi,
  type ProviderConfig,
  type ProviderHttpOptions,
  type ProviderKind,
} from '../../server/src/llm/providers';
import {
  CONTEXT_WINDOW_MAX_TOKENS,
  CONTEXT_WINDOW_MIN_TOKENS,
  ownModel,
  pricingFor,
  WORKSPACE_ID_PATTERN,
  type PricePair,
  type StoredPricing,
} from '../../server/src/llm/settings';
import { llmBaseUrlProblem } from '../../server/src/llm/url';
import { scrubTurn } from '../../server/src/review/key-scrub';
import { modelFor, type ModelTier } from '../../server/src/review/model-tiers';
import { converseOverTools } from '../../server/src/review/tool-conversation';
import { REVIEW_CALL_MIN_TIMEOUT_SECONDS } from '../../server/src/review/usage';
import { normalBaseUrl, parseInternalHosts } from '../../server/src/scm/url';
import { hostOf, isNonPublicAddress } from '../../server/src/webhooks/url';
import {
  EVAL_DIR,
  formatReport,
  loadCases,
  runEval,
  type EvalCase,
  type EvalDeps,
  type EvalReport,
} from './eval';

/*
 * Plan 6I-3 Task 14 (spec §12): the evaluation of the AI review against a real provider, run only
 * by hand through `pnpm review:live` (review.live.test.ts); no CI job runs it. It reviews the cases
 * of fixtures/review-eval, the synthetic evaluation set and nothing else, with the server's own
 * review: the same prompts, tools, loop and checks, over the provider the person names. It prints
 * aggregates only (formatReport): never a prompt, an answer, a line of a fixture or the key.
 *
 * The review has the three model tiers of the server's own: `QUALOR_LIVE_REVIEW_STRONG_MODEL` and
 * `QUALOR_LIVE_REVIEW_FAST_MODEL` name the models of the strong and the fast tier, and a tier left
 * empty uses the model, as in the AI settings. Each call goes to the model of its tier, and its cost
 * is figured at that model's prices. An organisation-wide Anthropic key that is not scoped to a
 * workspace needs `QUALOR_LIVE_REVIEW_WORKSPACE_ID` (`wrkspc_…`), which every call sends as the
 * AI settings' Workspace ID does. The newest OpenAI models take function tools only through the
 * Responses API: `QUALOR_LIVE_REVIEW_API=responses` asks through it, as the AI settings' API does
 * (`chat_completions`, the default, is what the OpenAI-compatible servers serve). A model with a
 * context window smaller than 1 000 000 tokens takes it in `QUALOR_LIVE_REVIEW_CONTEXT_WINDOW`
 * (8 000 to 10 000 000), as the AI provider's Context window: no call sends more than it less the
 * room for the answer.
 *
 * The provider is whatever the person sets in the environment. The host they type is the one they
 * mean to call, so it is allowed whatever its address is (a local model, a gateway on the company
 * network); the server's other rules for a base URL apply (no credentials, no query, never a
 * link-local or cloud metadata address). Plain http only to this machine or an address of its
 * network written out, so that a mistyped `http` never sends the key across the internet in clear.
 * Checked against the fake provider by review-live.test.ts.
 */

/** A call's timeout: what a review call waits at least on the server, with the default settings. */
const CALL_TIMEOUT_SECONDS = REVIEW_CALL_MIN_TIMEOUT_SECONDS;
/** What the server accepts as an API key: printable ASCII without spaces (llm.md §3.2). */
const API_KEY = /^[\x21-\x7e]{1,4096}$/;
/** The settings' bound for a price, USD for a million tokens (pricingSchema). */
const MAX_PRICE = 10_000;
const MAX_RUNS = 5;

type Env = Readonly<Record<string, string | undefined>>;

export interface LiveOptions {
  /** The provider's base URL. */
  url: string;
  /** The standard model, which a tier without a model of its own uses too. */
  model: string;
  kind: ProviderKind;
  /**
   * The API an OpenAI-compatible provider is asked through (`QUALOR_LIVE_REVIEW_API`); Anthropic has
   * one, and is always `chat_completions` here.
   */
  api: ProviderApi;
  /** The key the provider is called with; never printed. */
  apiKey: string | null;
  /**
   * The workspace an organisation-wide Anthropic key that is not scoped to one names in every
   * request (`anthropic-workspace-id`); null: none. An OpenAI-compatible server has none.
   */
  workspaceId: string | null;
  /** Times each case is reviewed. */
  runs: number;
  /** The cases to review, by name; null: all of them. */
  cases: string[] | null;
  /** The model of the strong tier (the judge and the verification); null: the tier uses `model`. */
  strongModel: string | null;
  /**
   * The model of the fast tier (the quality reviewer of a trivial review); null: the tier uses
   * `model`.
   */
  fastModel: string | null;
  /** USD for a million tokens, of `model`; null: no cost is reported. */
  prices: PricePair | null;
  /**
   * The prices of the strong and of the fast model, needed for a cost when the tier has a model of
   * its own: a tier that has one and no prices has no cost at all, never the prices of `model`.
   */
  strongPrices: PricePair | null;
  fastPrices: PricePair | null;
  /**
   * The model's context window, in tokens (`QUALOR_LIVE_REVIEW_CONTEXT_WINDOW`), one for every
   * tier; null: 1 000 000, as the AI settings read an empty one.
   */
  contextWindowTokens: number | null;
}

/** The project `review-live` exists (vitest.config.ts) only with both variables set. */
export function liveEnabled(env: Env): boolean {
  return (env.QUALOR_LIVE_REVIEW_URL ?? '') !== '' && (env.QUALOR_LIVE_REVIEW_MODEL ?? '') !== '';
}

function price(env: Env, name: string): number | null {
  const raw = env[name];
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > MAX_PRICE) {
    throw new Error(`${name} must be a number of USD for a million tokens, from 0 to ${MAX_PRICE}`);
  }
  return value;
}

/** The prices of a model from `<prefix>_IN` and `<prefix>_OUT`: a cost needs both. */
function pricePair(env: Env, prefix: string): PricePair | null {
  const input = price(env, `${prefix}_IN`);
  const output = price(env, `${prefix}_OUT`);
  return input === null || output === null
    ? null
    : { inputUsdPerMTok: input, outputUsdPerMTok: output };
}

/** The model of a tier from its variable; null when it is not set or is empty. */
function tierModel(env: Env, name: string): string | null {
  const value = env[name] ?? '';
  return value === '' ? null : value;
}

export function readLiveEnv(env: Env): LiveOptions {
  const url = env.QUALOR_LIVE_REVIEW_URL ?? '';
  const model = env.QUALOR_LIVE_REVIEW_MODEL ?? '';
  if (url === '') {
    throw new Error(
      'Set QUALOR_LIVE_REVIEW_URL to the provider, as the AI settings take it: https://api.openai.com/v1, or https://api.anthropic.com with QUALOR_LIVE_REVIEW_KIND=anthropic',
    );
  }
  if (model === '') throw new Error('Set QUALOR_LIVE_REVIEW_MODEL');
  const kind = env.QUALOR_LIVE_REVIEW_KIND ?? 'openai';
  const known = PROVIDER_KINDS.find((candidate) => candidate === kind);
  if (known === undefined) {
    throw new Error(`QUALOR_LIVE_REVIEW_KIND must be ${PROVIDER_KINDS.join(' or ')}`);
  }
  const key = env.QUALOR_LIVE_REVIEW_API_KEY ?? '';
  if (key !== '' && !API_KEY.test(key)) {
    // Never the value itself.
    throw new Error(
      'QUALOR_LIVE_REVIEW_API_KEY must be 1 to 4096 printable ASCII characters without spaces',
    );
  }
  const rawApi = env.QUALOR_LIVE_REVIEW_API ?? '';
  const api = rawApi === '' ? 'chat_completions' : rawApi;
  const knownApi = PROVIDER_APIS.find((candidate) => candidate === api);
  if (knownApi === undefined) {
    throw new Error(`QUALOR_LIVE_REVIEW_API must be ${PROVIDER_APIS.join(' or ')}`);
  }
  const workspace = env.QUALOR_LIVE_REVIEW_WORKSPACE_ID ?? '';
  if (workspace !== '' && !WORKSPACE_ID_PATTERN.test(workspace)) {
    throw new Error(
      'QUALOR_LIVE_REVIEW_WORKSPACE_ID must be wrkspc_ and then 1 to 64 letters or digits',
    );
  }
  const rawRuns = env.QUALOR_LIVE_REVIEW_RUNS ?? '';
  const runs = rawRuns === '' ? 1 : Number(rawRuns);
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) {
    throw new Error(`QUALOR_LIVE_REVIEW_RUNS must be a whole number from 1 to ${MAX_RUNS}`);
  }
  const rawWindow = env.QUALOR_LIVE_REVIEW_CONTEXT_WINDOW ?? '';
  const window = rawWindow === '' ? null : Number(rawWindow);
  if (
    window !== null &&
    (!Number.isInteger(window) ||
      window < CONTEXT_WINDOW_MIN_TOKENS ||
      window > CONTEXT_WINDOW_MAX_TOKENS)
  ) {
    throw new Error(
      `QUALOR_LIVE_REVIEW_CONTEXT_WINDOW must be a whole number of tokens from ${CONTEXT_WINDOW_MIN_TOKENS} to ${CONTEXT_WINDOW_MAX_TOKENS}`,
    );
  }
  const names = (env.QUALOR_LIVE_REVIEW_CASES ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  return {
    url,
    model,
    kind: known,
    api: known === 'anthropic' ? 'chat_completions' : knownApi,
    apiKey: key === '' ? null : key,
    workspaceId: known === 'anthropic' && workspace !== '' ? workspace : null,
    runs,
    cases: names.length === 0 ? null : names,
    strongModel: tierModel(env, 'QUALOR_LIVE_REVIEW_STRONG_MODEL'),
    fastModel: tierModel(env, 'QUALOR_LIVE_REVIEW_FAST_MODEL'),
    prices: pricePair(env, 'QUALOR_LIVE_REVIEW_PRICE'),
    strongPrices: pricePair(env, 'QUALOR_LIVE_REVIEW_STRONG_PRICE'),
    fastPrices: pricePair(env, 'QUALOR_LIVE_REVIEW_FAST_PRICE'),
    contextWindowTokens: window,
  };
}

/**
 * The field that limits the answer an OpenAI-compatible server needs, as the AI settings page
 * chooses it for a base URL: OpenAI's and Azure OpenAI's current models refuse `max_tokens`, and
 * vLLM, Ollama and the others want it. (Anthropic's adapter has its own and ignores this.)
 */
function outputLimitField(url: string): ProviderConfig['maxTokensField'] {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'max_tokens';
  }
  return host === 'api.openai.com' || host.endsWith('.openai.azure.com')
    ? 'max_completion_tokens'
    : 'max_tokens';
}

/**
 * Whether the URL's host is this machine or on its network, as far as the URL itself says:
 * `localhost` (or a name under it), or a loopback or private address written out. A name could be
 * anywhere, so it is not.
 */
function nearby(url: URL): boolean {
  const host = hostOf(url);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return isIP(host) !== 0 && isNonPublicAddress(host);
}

/**
 * What the provider calls need: the settings of a call, as the AI settings would store them, and
 * the one host the calls may go to whatever its address. Throws for a URL the server would refuse,
 * and for plain http to a host that is not nearby: the key would cross the network in clear.
 */
export function providerOf(
  o: Pick<LiveOptions, 'url' | 'model' | 'kind' | 'api' | 'workspaceId'>,
): {
  config: ProviderConfig;
  http: ProviderHttpOptions;
} {
  let url: URL;
  try {
    url = new URL(o.url);
  } catch {
    throw new Error('QUALOR_LIVE_REVIEW_URL is not a valid URL');
  }
  const internalHosts = parseInternalHosts(url.host);
  const problem = llmBaseUrlProblem(o.url, internalHosts);
  if (problem !== null) throw new Error(`QUALOR_LIVE_REVIEW_URL: ${problem}`);
  if (url.protocol === 'http:' && !nearby(url)) {
    throw new Error(
      'QUALOR_LIVE_REVIEW_URL: use https; http only for localhost or a loopback or private address, so that the key never crosses the network in clear',
    );
  }
  const baseUrl = normalBaseUrl(o.url);
  return {
    config: {
      kind: o.kind,
      api: o.api,
      baseUrl,
      model: o.model,
      auth: 'bearer',
      // The review's calls carry tools, and a conversation with tools asks for its JSON in the prompt.
      jsonMode: 'none',
      maxTokensField: outputLimitField(baseUrl),
      temperature: null,
      workspaceId: o.workspaceId,
      timeoutSeconds: CALL_TIMEOUT_SECONDS,
    },
    http: { internalHosts, version: 'review-live' },
  };
}

function chosen(all: readonly EvalCase[], names: readonly string[] | null): EvalCase[] {
  if (names === null) return [...all];
  const unknown = names.filter((name) => !all.some((c) => c.id === name));
  if (unknown.length > 0) {
    throw new Error(
      `QUALOR_LIVE_REVIEW_CASES names no such case: ${unknown.join(', ')} (the cases are ${all.map((c) => c.id).join(', ')})`,
    );
  }
  return all.filter((c) => names.includes(c.id));
}

export interface LiveResult {
  report: EvalReport;
  /** What is printed: the model, the scores and, if any call failed, how. Aggregates only. */
  text: string;
}

/**
 * Reviews the chosen cases with the provider, one review after the other and each `runs` times.
 * Throws before any call when the URL is refused or a case is unknown, and refuses to return a
 * text that holds the key.
 */
export async function runLive(
  o: LiveOptions,
  /** Told after each review: how many are done, of how many, and the tokens spent so far. */
  progress?: EvalDeps['progress'],
): Promise<LiveResult> {
  const { config, http } = providerOf(o);
  const cases = chosen(loadCases(EVAL_DIR), o.cases);
  const models = { model: o.model, strongModel: o.strongModel, fastModel: o.fastModel };
  /** The prices as the AI settings would hold them: of the model, and of each tier that has its own. */
  const pricing: StoredPricing =
    o.prices === null ? null : { ...o.prices, strong: o.strongPrices, fast: o.fastPrices };
  /** How the provider's calls failed, by the fixed word of the failure. */
  const failures: Record<string, number> = {};
  /** The call to the model of `tier`. */
  const sendTo =
    (tier: ModelTier) =>
    async (conversation: LlmConversation): Promise<LlmTurn> => {
      try {
        // What the model said is used without the provider's key, as the job's sender returns it.
        return scrubTurn(
          await converse(
            { ...config, model: modelFor(models, tier) },
            o.apiKey,
            conversation,
            http,
          ),
          o.apiKey,
        );
      } catch (err) {
        if (err instanceof LlmError) failures[err.failure] = (failures[err.failure] ?? 0) + 1;
        throw err;
      }
    };
  const senders: Record<ModelTier, (conversation: LlmConversation) => Promise<LlmTurn>> = {
    strong: sendTo('strong'),
    standard: sendTo('standard'),
    fast: sendTo('fast'),
  };
  const report = await runEval(cases, {
    runs: o.runs,
    prices: (tier) => pricingFor(pricing, models, tier),
    progress,
    contextWindowTokens: o.contextWindowTokens,
    pipelineFor: ({ reader, policy }) => ({
      providerKey: o.apiKey,
      converse: (role, user, nonce, tokenBudget, accept, modelTier) =>
        converseOverTools(
          { role, user, nonce, tokenBudget, accept },
          {
            reader,
            policy,
            send: senders[modelTier],
            shouldStop: () => Promise.resolve(false),
            contextWindowTokens: o.contextWindowTokens,
          },
        ),
    }),
  });
  const failed = Object.entries(failures).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // With a model of its own for a tier, every tier's model is named: the one it runs on.
  const tiers =
    ownModel(models, 'strong') === null && ownModel(models, 'fast') === null
      ? ''
      : `, strong ${modelFor(models, 'strong')}, fast ${modelFor(models, 'fast')}`;
  const text = [
    `model: ${o.model} (${o.kind})${tiers}`,
    formatReport(report),
    ...(failed.length === 0
      ? []
      : [`provider failures: ${failed.map(([failure, n]) => `${failure} ${n}`).join(', ')}`]),
  ].join('\n');
  if (o.apiKey !== null && text.includes(o.apiKey)) {
    throw new Error('The live report would hold the API key; not printed');
  }
  return { report, text };
}
