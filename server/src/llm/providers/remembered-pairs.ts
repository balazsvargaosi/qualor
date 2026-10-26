import type { ProviderConfig } from './types';

/** How many pairs of a base URL and a model a process remembers of each thing it learns of them. */
export const MAX_REMEMBERED_PAIRS = 1_000;

/**
 * The pairs of a base URL and a model that a process has learned a thing of (that the model
 * refuses the room to think, that its server does not stream): a set bounded to `limit`, the oldest
 * dropped first (a pair added again is the newest). It is in memory only, so a process learns each
 * pair once, and a restart learns it again.
 */
export class RememberedPairs {
  private readonly pairs = new Set<string>();

  constructor(private readonly limit = MAX_REMEMBERED_PAIRS) {}

  has(pair: string): boolean {
    return this.pairs.has(pair);
  }

  add(pair: string): void {
    this.pairs.delete(pair);
    this.pairs.add(pair);
    for (const oldest of this.pairs) {
      if (this.pairs.size <= this.limit) break;
      this.pairs.delete(oldest);
    }
  }

  get size(): number {
    return this.pairs.size;
  }
}

/**
 * A model is its address and its name: a base URL pasted with a trailing slash is the same
 * address (as `postJson` reads it).
 */
export function pairOf(config: ProviderConfig): string {
  return `${config.baseUrl.replace(/\/+$/, '')}\n${config.model}`;
}
