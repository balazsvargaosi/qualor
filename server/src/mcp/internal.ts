import { randomBytes } from 'node:crypto';
import type { OAuthPrincipal } from '../auth/principal';

export const INTERNAL_HEADER = 'x-qualor-internal';
const LIFETIME_MS = 30_000;

/**
 * Ruling R4: an MCP tool's in-process REST call carries a one-time key for its principal. A key
 * is 32 random bytes, used once, forgotten after 30 s, and never leaves the process, so a request
 * from the network can never present a valid one.
 */
export class InternalCalls {
  private readonly pending = new Map<string, { principal: OAuthPrincipal; expires: number }>();

  issue(principal: OAuthPrincipal): string {
    this.sweep();
    const key = randomBytes(32).toString('base64url');
    this.pending.set(key, { principal, expires: Date.now() + LIFETIME_MS });
    return key;
  }

  take(key: string): OAuthPrincipal | null {
    const entry = this.pending.get(key);
    this.pending.delete(key);
    this.sweep();
    if (!entry || entry.expires < Date.now()) return null;
    return entry.principal;
  }

  size(): number {
    this.sweep();
    return this.pending.size;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.pending) if (entry.expires < now) this.pending.delete(key);
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    internalCalls: InternalCalls;
  }
}
