import type { ReviewTier } from '../db/schema';
import { MODEL_TIERS, ownModel, type StoredProvider } from '../llm/settings';
import type { ReviewRole } from './prompts';

/**
 * The model tiers of AI review (`ModelTier`, not "tier", which is the size of a review): the
 * provider has up to three models, and each step of a review runs on the tier its role names. An
 * admin sets each model; the strong and the fast one are optional, and an empty one is the standard
 * model. The union is the list's (`MODEL_TIERS`), so the list holds every tier.
 */
export type ModelTier = (typeof MODEL_TIERS)[number];

/** The fields of the stored provider that name the models. */
type TierModels = Pick<StoredProvider, 'model' | 'strongModel' | 'fastModel'>;

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
  for (const tier of MODEL_TIERS) {
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

/**
 * Every conversation AI review has with the provider: the roles of a review, and the answer to a
 * person's reply in a merge request. The review pipeline plans the roles of a review only.
 */
export type ConversationRole = ReviewRole | 'reply';

/**
 * The tier of the model each role runs on. The judge and the verification decide what is kept and
 * what is raised, so they get the strong model; the specialists and the reply, the standard one
 * (`tierOfCall` has one exception).
 */
export const ROLE_MODEL_TIER: Readonly<Record<ConversationRole, ModelTier>> = Object.freeze({
  judge: 'strong',
  verify: 'strong',
  security: 'standard',
  quality: 'standard',
  tests: 'standard',
  performance: 'standard',
  reply: 'standard',
});

/**
 * The tier of one call: its role's, except for the quality reviewer of a trivial review (the
 * smallest `sizeTier`), which runs on the fast model: a change of a few lines needs no more. The
 * security reviewer, which a sensitive path adds at any size, stays on the standard model: its
 * recall matters more than its cost. `sizeTier` is the review's size, not a model tier, and null
 * for a call that is part of no review.
 */
export function tierOfCall(role: ConversationRole, sizeTier: ReviewTier | null): ModelTier {
  return role === 'quality' && sizeTier === 'trivial' ? 'fast' : ROLE_MODEL_TIER[role];
}
