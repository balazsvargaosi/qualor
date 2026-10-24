import { isIP } from 'node:net';
import {
  converse,
  LlmError,
  PROVIDER_KINDS,
  type LlmConversation,
  type LlmTurn,
  type ProviderConfig,
  type ProviderHttpOptions,
  type ProviderKind,
} from '../../server/src/llm/providers';
import { llmBaseUrlProblem } from '../../server/src/llm/url';
import { scrubTurn } from '../../server/src/review/key-scrub';
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
  model: string;
  kind: ProviderKind;
  /** The key the provider is called with; never printed. */
  apiKey: string | null;
  /** Times each case is reviewed. */
  runs: number;
  /** The cases to review, by name; null: all of them. */
  cases: string[] | null;
  /** USD for a million tokens; null: no cost is reported. */
  prices: { inputUsdPerMTok: number; outputUsdPerMTok: number } | null;
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
  const rawRuns = env.QUALOR_LIVE_REVIEW_RUNS ?? '';
  const runs = rawRuns === '' ? 1 : Number(rawRuns);
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) {
    throw new Error(`QUALOR_LIVE_REVIEW_RUNS must be a whole number from 1 to ${MAX_RUNS}`);
  }
  const names = (env.QUALOR_LIVE_REVIEW_CASES ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  const input = price(env, 'QUALOR_LIVE_REVIEW_PRICE_IN');
  const output = price(env, 'QUALOR_LIVE_REVIEW_PRICE_OUT');
  return {
    url,
    model,
    kind: known,
    apiKey: key === '' ? null : key,
    runs,
    cases: names.length === 0 ? null : names,
    // A cost needs both prices.
    prices:
      input === null || output === null
        ? null
        : { inputUsdPerMTok: input, outputUsdPerMTok: output },
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
export function providerOf(o: Pick<LiveOptions, 'url' | 'model' | 'kind'>): {
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
      baseUrl,
      model: o.model,
      auth: 'bearer',
      // The review's calls carry tools, and a conversation with tools asks for its JSON in the prompt.
      jsonMode: 'none',
      maxTokensField: outputLimitField(baseUrl),
      temperature: null,
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
  /** How the provider's calls failed, by the fixed word of the failure. */
  const failures: Record<string, number> = {};
  const send = async (conversation: LlmConversation): Promise<LlmTurn> => {
    try {
      // What the model said is used without the provider's key, as the job's sender returns it.
      return scrubTurn(await converse(config, o.apiKey, conversation, http), o.apiKey);
    } catch (err) {
      if (err instanceof LlmError) failures[err.failure] = (failures[err.failure] ?? 0) + 1;
      throw err;
    }
  };
  const report = await runEval(cases, {
    runs: o.runs,
    prices: o.prices,
    progress,
    pipelineFor: ({ reader, policy }) => ({
      providerKey: o.apiKey,
      converse: (role, user, nonce, tokenBudget, accept) =>
        converseOverTools(
          { role, user, nonce, tokenBudget, accept },
          { reader, policy, send, shouldStop: () => Promise.resolve(false) },
        ),
    }),
  });
  const failed = Object.entries(failures).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const text = [
    `model: ${o.model} (${o.kind})`,
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
