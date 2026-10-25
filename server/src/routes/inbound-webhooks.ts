import type { FastifyInstance } from 'fastify';

/*
 * What GitHub's and GitLab's public webhook routes share (github-webhooks.ts,
 * gitlab-webhooks.ts): the one body they take (JSON, as raw bytes, up to 1 MiB), the ids of the
 * deliveries they have seen, and how they read a header and an id. Each route is a plugin of its
 * own, so its parser stays in its own context.
 */

/** github.md §9: the events Qualor reads are a few KiB; GitHub caps payloads at 25 MB. */
export const WEBHOOK_BODY_LIMIT = 1024 * 1024;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DELIVERY_TTL_MS = 60 * 60_000;
const MAX_DELIVERIES = 10_000;

/** A header's value when it came once; a header sent twice, or none, reads as empty. */
export const header = (value: string | string[] | undefined): string =>
  typeof value === 'string' ? value : '';

/**
 * Makes JSON the plugin's only body type, read as raw bytes (a Buffer): the inherited parsers
 * (text/plain gives a string) are removed in this plugin's context, so any other type is a 415
 * before the handler runs. A signature is over the body exactly as sent (github.md §9).
 */
export function jsonBufferParser(app: FastifyInstance): void {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT },
    (_request, body, done) => done(null, body),
  );
}

/** Delivery ids seen in the last hour by this process (github.md §9). */
export class DeliveryIds {
  readonly #seen = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** True the first time an id is seen within the hour. */
  remember(id: string): boolean {
    const t = this.now();
    const key = id.toLowerCase();
    const at = this.#seen.get(key);
    if (at !== undefined && t - at < DELIVERY_TTL_MS) return false;
    this.#seen.delete(key);
    while (this.#seen.size >= MAX_DELIVERIES) {
      const oldest = this.#seen.keys().next().value;
      if (oldest === undefined) break;
      this.#seen.delete(oldest);
    }
    this.#seen.set(key, t);
    return true;
  }

  /** Forgets an id whose processing failed, so the sender's redelivery of it is processed. */
  forget(id: string): void {
    this.#seen.delete(id.toLowerCase());
  }
}
