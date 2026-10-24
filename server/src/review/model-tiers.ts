import { ownModel, type StoredProvider } from '../llm/settings';

/**
 * The model tiers of AI review (`ModelTier`, not "tier", which is the size of a review): the
 * provider has up to three models, and each step of a review runs on the tier its role names. An
 * admin sets each model; the strong and the fast one are optional, and an empty one is the standard
 * model.
 */
export type ModelTier = 'strong' | 'standard' | 'fast';

/** The fields of the stored provider that name the models. */
type TierModels = Pick<StoredProvider, 'model' | 'strongModel' | 'fastModel'>;

/** The tiers in the order their models are listed: the standard model comes first. */
const TIERS: readonly ModelTier[] = ['standard', 'strong', 'fast'];

/** The model of the tier: its own, or the standard model when it has none. */
export function modelFor(provider: TierModels, tier: ModelTier): string {
  return ownModel(provider, tier) ?? provider.model;
}

/**
 * The provider's models with the tier that first uses each: the standard model first, then the
 * strong and the fast model unless it is a model already listed.
 */
export function tierModels(provider: TierModels): { tier: ModelTier; model: string }[] {
  const listed: { tier: ModelTier; model: string }[] = [];
  for (const tier of TIERS) {
    const model = modelFor(provider, tier);
    if (!listed.some((entry) => entry.model === model)) listed.push({ tier, model });
  }
  return listed;
}

/** A list of models as a set: each once, sorted. */
export const modelSet = (models: readonly string[]): string[] => [...new Set(models)].sort();

/** Whether two lists name the same set of models, whatever their order and repeats. */
export function sameModels(a: readonly string[], b: readonly string[]): boolean {
  const left = modelSet(a);
  const right = modelSet(b);
  return left.length === right.length && left.every((model, i) => model === right[i]);
}

/** Every model of the provider once, sorted: what a consent and its notice name. */
export function distinctModels(provider: TierModels): string[] {
  return modelSet(tierModels(provider).map((entry) => entry.model));
}
