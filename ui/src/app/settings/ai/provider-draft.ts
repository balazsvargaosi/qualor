import { formatAmount, formatWhole, parseMoney, parseWhole } from '../../shared/numbers';
import { consentFields } from './consent-impact';
import type { LlmBody, LlmSettings } from './llm-body';

/*
 * The Provider section's draft (`q-ai-provider-section`): the provider and its prices as the
 * section holds them, how they compare with what is saved, what a save sends of the prices and the
 * temperature, the addresses as the server reads them, and the section's own words for a refused
 * field.
 */

export type Kind = '' | 'openai' | 'anthropic';
export type OpenAiApi = 'chat_completions' | 'responses';
export type KeyHeader = 'bearer' | 'api-key';
export type OutputLimit = 'max_tokens' | 'max_completion_tokens';
export type Tier = 'standard' | 'strong' | 'fast';
type PriceKey =
  | 'priceInput'
  | 'priceOutput'
  | 'priceStrongInput'
  | 'priceStrongOutput'
  | 'priceFastInput'
  | 'priceFastOutput';

/**
 * The provider and its prices as the section holds them: each field as typed, each switch. A
 * group switched off keeps its fields, which come back with it; only the key is never here.
 */
export interface Draft {
  kind: Kind;
  url: string;
  model: string;
  tiers: boolean;
  strongModel: string;
  fastModel: string;
  workspaceId: string;
  prices: boolean;
  priceInput: string;
  priceOutput: string;
  priceStrongInput: string;
  priceStrongOutput: string;
  priceFastInput: string;
  priceFastOutput: string;
  api: OpenAiApi;
  auth: KeyHeader;
  json: boolean;
  maxTokensField: OutputLimit;
  timeout: string;
  /** Empty means the default (1 000 000 tokens). */
  contextWindow: string;
  temperatureSet: boolean;
  temperature: string;
  /** Remove the key was pressed: a save removes the stored key. */
  removeKey: boolean;
}

/** The fields a refusal can point at, in the section's order; each is the input `#ai-<field>`. */
export const FIELDS = [
  'kind',
  'url',
  'key',
  'workspace-id',
  'model',
  'strong-model',
  'fast-model',
  'price-input',
  'price-output',
  'price-strong-input',
  'price-strong-output',
  'price-fast-input',
  'price-fast-output',
  'timeout',
  'context-window',
  'temperature',
] as const;
export type Field = (typeof FIELDS)[number];
export type PriceField = Extract<Field, `price-${string}`>;

/** The models' rows in the prices table, in its order. */
const TIERS: readonly Tier[] = ['standard', 'strong', 'fast'];
/** Each row's fields: the input price, then the output price. */
export const PRICE_ROWS: Readonly<Record<Tier, readonly [PriceField, PriceField]>> = {
  standard: ['price-input', 'price-output'],
  strong: ['price-strong-input', 'price-strong-output'],
  fast: ['price-fast-input', 'price-fast-output'],
};
/** Each price field's row, and where the draft keeps its text. */
export const PRICE_FIELDS: Readonly<Record<PriceField, { tier: Tier; key: PriceKey }>> = {
  'price-input': { tier: 'standard', key: 'priceInput' },
  'price-output': { tier: 'standard', key: 'priceOutput' },
  'price-strong-input': { tier: 'strong', key: 'priceStrongInput' },
  'price-strong-output': { tier: 'strong', key: 'priceStrongOutput' },
  'price-fast-input': { tier: 'fast', key: 'priceFastInput' },
  'price-fast-output': { tier: 'fast', key: 'priceFastOutput' },
};
/** The most a temperature may be: OpenAI-compatible providers only, Anthropic's models take none. */
const MAX_TEMPERATURE = 2;
/** The most a price may be, in US dollars per million tokens. */
const MAX_PRICE = 10_000;
export const DEFAULT_TIMEOUT = 60;
/** The bounds of the context window, in tokens, as the server holds them. */
export const CONTEXT_WINDOW_MIN = 8000;
export const CONTEXT_WINDOW_MAX = 10_000_000;
/** OpenAI's own host, whose newest models call tools only through the Responses API. */
export const OPENAI_HOST = 'api.openai.com';
/**
 * A price as people write it: digits grouped in threes by commas, and any decimals after a point;
 * a point with nothing after it ("5.") or before it (".5") reads as the number.
 */
const PRICE = /^(?:\d+|\d{1,3}(?:,\d{3})+)?(?:\.\d*)?$/;
const SEPARATORS = /[\s_\u00a0\u202f]/g;

/**
 * The output limit parameter an OpenAI-compatible base URL needs by default (llm.md §2.2): OpenAI's
 * and Azure OpenAI's current models refuse `max_tokens`; vLLM, Ollama and the others want it.
 */
export function defaultOutputLimitField(url: string): OutputLimit {
  const host = hostOf(url);
  return host !== null && (host === OPENAI_HOST || host.endsWith('.openai.azure.com'))
    ? 'max_completion_tokens'
    : 'max_tokens';
}

/** The provider and prices of the settings as the section holds them; none for no settings. */
export function draftOf(settings: LlmSettings | null, locale: string): Draft {
  const p = settings?.provider ?? null;
  const pricing = settings?.pricing ?? null;
  // As the money field writes it, without rounding a price of more decimals away.
  const price = (n: number | undefined) => (n === undefined ? '' : formatAmount(n, locale));
  return {
    kind: p?.kind ?? '',
    url: p?.baseUrl ?? '',
    model: p?.model ?? '',
    tiers: (p?.strongModel ?? null) !== null || (p?.fastModel ?? null) !== null,
    strongModel: p?.strongModel ?? '',
    fastModel: p?.fastModel ?? '',
    workspaceId: p?.workspaceId ?? '',
    prices: pricing !== null,
    priceInput: price(pricing?.inputUsdPerMTok),
    priceOutput: price(pricing?.outputUsdPerMTok),
    priceStrongInput: price(pricing?.strong?.inputUsdPerMTok),
    priceStrongOutput: price(pricing?.strong?.outputUsdPerMTok),
    priceFastInput: price(pricing?.fast?.inputUsdPerMTok),
    priceFastOutput: price(pricing?.fast?.outputUsdPerMTok),
    // A provider saved before the API was a setting asks through Chat Completions.
    api: p?.api ?? 'chat_completions',
    auth: p?.auth ?? 'bearer',
    json: (p?.jsonMode ?? 'json_object') === 'json_object',
    maxTokensField: p?.maxTokensField ?? 'max_tokens',
    timeout: formatWhole(p?.timeoutSeconds ?? DEFAULT_TIMEOUT, locale),
    contextWindow: p?.contextWindowTokens ? formatWhole(p.contextWindowTokens, locale) : '',
    temperatureSet: (p?.temperature ?? null) !== null,
    temperature: (p?.temperature ?? null) === null ? '' : String(p?.temperature),
    removeKey: false,
  };
}

/**
 * The draft's changes from what is saved, by name, as a save would send them: a tier's model while
 * its switch is on, the shown prices while theirs is on, the OpenAI options for that kind only
 * (Anthropic stores their defaults), numbers by their value, and the key typed or removed.
 */
export function changesOf(d: Draft, b: Draft, keyTyped: boolean): ReadonlySet<string> {
  const changed = new Set<string>();
  const differ = (key: string, x: unknown, y: unknown) => {
    if (!Object.is(x, y)) changed.add(key);
  };
  const openAi = <T>(x: Draft, value: T, otherwise: T) => (x.kind === 'openai' ? value : otherwise);
  differ('kind', d.kind, b.kind);
  differ('url', normalUrl(d.url), normalUrl(b.url));
  differ('model', d.model.trim(), b.model.trim());
  differ('strongModel', d.tiers ? d.strongModel.trim() : '', b.tiers ? b.strongModel.trim() : '');
  differ('fastModel', d.tiers ? d.fastModel.trim() : '', b.tiers ? b.fastModel.trim() : '');
  differ(
    'workspaceId',
    d.kind === 'anthropic' ? d.workspaceId.trim() : '',
    b.kind === 'anthropic' ? b.workspaceId.trim() : '',
  );
  if (d.prices !== b.prices) {
    changed.add('prices');
  } else if (d.prices) {
    for (const tier of pricedTiers(d)) {
      for (const field of PRICE_ROWS[tier]) {
        const { key } = PRICE_FIELDS[field];
        differ(key, priceValue(d[key]), priceValue(b[key]));
      }
    }
  }
  differ('api', openAi(d, d.api, 'chat_completions'), openAi(b, b.api, 'chat_completions'));
  differ('auth', openAi(d, d.auth, 'bearer'), openAi(b, b.auth, 'bearer'));
  differ('json', openAi(d, d.json, true), openAi(b, b.json, true));
  differ(
    'maxTokensField',
    openAi(d, d.maxTokensField, 'max_tokens'),
    openAi(b, b.maxTokensField, 'max_tokens'),
  );
  differ('timeout', wholeValue(d.timeout), wholeValue(b.timeout));
  differ('contextWindow', wholeValue(d.contextWindow), wholeValue(b.contextWindow));
  differ('temperature', temperatureValue(d), temperatureValue(b));
  if (d.removeKey || keyTyped) changed.add('key');
  return changed;
}

/** A tier's model as the server counts it: its own when set and not the standard one, else none. */
function ownModel(d: Draft, tier: Tier): string | null {
  if (tier === 'standard' || d.kind === '' || !d.tiers) return null;
  const model = (tier === 'strong' ? d.strongModel : d.fastModel).trim();
  return model === '' || model === d.model.trim() ? null : model;
}

/** The model a price row is for. */
export function modelOf(d: Draft, tier: Tier): string {
  return ownModel(d, tier) ?? d.model.trim();
}

/** The rows of the prices table: the standard model, and each tier with a model of its own. */
export function pricedTiers(d: Draft): Tier[] {
  return TIERS.filter((tier) => tier === 'standard' || ownModel(d, tier) !== null);
}

/**
 * The prices part of the body: null while their switch is off or none is given; refused through
 * `refuse` otherwise. Once a price is given the server needs the standard model's pair and the
 * pair of each tier that has a model of its own, so a pair left out is refused; a tier without a
 * model of its own sends none.
 */
export function pricingOf(d: Draft, refuse: (field: Field) => void): LlmBody['pricing'] {
  if (!d.prices) return null;
  const typed = pricedTiers(d).some((tier) =>
    PRICE_ROWS[tier].some((field) => d[PRICE_FIELDS[field].key].trim() !== ''),
  );
  if (!typed) return null;
  const price = (field: PriceField) => {
    const value = parsePrice(d[PRICE_FIELDS[field].key]);
    if (value === null) refuse(field);
    return value ?? 0;
  };
  const pair = (tier: Tier) => {
    const [input, output] = PRICE_ROWS[tier];
    return { inputUsdPerMTok: price(input), outputUsdPerMTok: price(output) };
  };
  return {
    ...pair('standard'),
    strong: ownModel(d, 'strong') === null ? null : pair('strong'),
    fast: ownModel(d, 'fast') === null ? null : pair('fast'),
  };
}

/**
 * The temperature the body sends: none for Anthropic (its current models take none), while the
 * switch is off, or while the field is empty; NaN for one that is not a number from 0 to 2.
 */
export function temperatureOf(d: Draft): number | null {
  const typed = d.temperature.trim();
  if (d.kind !== 'openai' || !d.temperatureSet || typed === '') return null;
  const n = Number(typed);
  return Number.isFinite(n) && n >= 0 && n <= MAX_TEMPERATURE ? n : Number.NaN;
}

/**
 * A price as typed, from 0 to 10 000: as the money field writes it ("1,000.00"), with more
 * decimals ("0.075"), or with a bare point ("5."); null when it is not one.
 */
function parsePrice(text: string): number | null {
  const grouped = parseMoney(text, MAX_PRICE);
  if (grouped !== null) return grouped;
  const plain = text.replace(SEPARATORS, '');
  if (plain === '' || plain === '.' || !PRICE.test(plain)) return null;
  const n = Number(plain.replaceAll(',', ''));
  return Number.isFinite(n) && n <= MAX_PRICE ? n : null;
}

/** A value to compare: the number a text stands for, else the text. */
const priceValue = (text: string) => parsePrice(text) ?? text.trim();
const wholeValue = (text: string) => parseWhole(text, 0, Number.MAX_SAFE_INTEGER) ?? text.trim();
function temperatureValue(d: Draft): number | string | null {
  const n = temperatureOf(d);
  return Number.isNaN(n) ? d.temperature.trim() : n;
}

/** The address as the server keeps it, or as typed when it does not parse. */
export function normalUrl(text: string): string {
  try {
    return consentFields({ baseUrl: text, model: '', strongModel: null, fastModel: null }).url;
  } catch {
    return text.trim();
  }
}

/** The host name of an address, in lower case; null when it does not parse. */
export function hostOf(text: string): string | null {
  try {
    return new URL(text.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The section's own words for a refused field (the server's text is never shown). */
export function refusal(field: Field): string {
  switch (field) {
    case 'kind':
      return $localize`:@@ai.settings.badKind:Choose OpenAI-compatible or Anthropic.`;
    case 'url':
      return $localize`:@@ai.settings.badUrl:Use the provider's http(s) address, such as https://api.openai.com/v1. An internal host must be listed, with its port, by the operator in QUALOR_LLM_INTERNAL_HOSTS.`;
    case 'model':
    case 'strong-model':
    case 'fast-model':
      return $localize`:@@ai.settings.badModel:Use the model's name as the provider spells it: letters, digits and . _ : / @ + - only.`;
    case 'key':
      return $localize`:@@ai.settings.keyForNewUrl:Enter the API key again for a new address, or press Remove the key. The key is 1 to 4096 printable characters without spaces.`;
    case 'workspace-id':
      return $localize`:@@ai.settings.badWorkspaceId:Use the workspace ID as the console shows it: wrkspc_ and then letters and digits.`;
    case 'timeout':
      return $localize`:@@ai.settings.badTimeout:Use a whole number of seconds from 5 to 600.`;
    case 'context-window':
      return $localize`:@@aiProvider.contextWindow.error:Enter a whole number of tokens from 8,000 to 10,000,000, or leave it empty.`;
    case 'temperature':
      return $localize`:@@ai.settings.badTemperature:Use a number from 0 to 2, or leave it empty.`;
    case 'price-input':
    case 'price-output':
      return $localize`:@@ai.settings.badPrice:Give both prices, in US dollars per million tokens (0 to 10000), or neither.`;
    case 'price-strong-input':
    case 'price-strong-output':
      return $localize`:@@ai.settings.badStrongPrice:Give the strong model's prices too, in US dollars per million tokens (0 to 10000).`;
    case 'price-fast-input':
    case 'price-fast-output':
      return $localize`:@@ai.settings.badFastPrice:Give the fast model's prices too, in US dollars per million tokens (0 to 10000).`;
  }
}

export function keyFormat(): string {
  return $localize`:@@ai.settings.keyFormat:This is not an API key: a key is 1 to 4096 printable characters without spaces.`;
}
