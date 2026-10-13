import { createHash } from 'node:crypto';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { first } from '../db/rows';
import { accountTokens, type AccountTokenKind } from '../db/schema';
import { randomBase62 } from './tokens';

/** Mail E2 A1: 43 base62 characters, about 256 bits. */
export const ACCOUNT_TOKEN_LENGTH = 43;
export const PASSWORD_RESET_TTL_MINUTES = 60;
export const INVITATION_TTL_MINUTES = 7 * 24 * 60;
/** An expired invitation stays this long, so Settings → Users can say "Invitation expired". */
export const EXPIRED_INVITATION_KEPT_DAYS = 30;
/** What a raw secret can look like; anything else is refused without a query. */
const PLAUSIBLE = /^[0-9A-Za-z]{1,100}$/;
/** Rows per pruning DELETE, as housekeeping's other steps. */
const PRUNE_BATCH = 5_000;

/** The stored key: SHA-256 of the raw secret, lowercase hex. The raw secret is never stored. */
export function accountTokenKey(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function plausibleAccountToken(raw: unknown): raw is string {
  return typeof raw === 'string' && PLAUSIBLE.test(raw);
}

export interface IssuedAccountToken {
  /** The raw secret: it goes into the email's link and nowhere else (never a log line). */
  token: string;
  expiresAt: Date;
}

/**
 * A new link for `(userId, kind)`, replacing the user's earlier one of that kind (an upsert on the
 * unique index), so only the newest link works. Expiry by the database clock.
 */
export async function issueAccountToken(
  tx: Executor,
  input: { userId: string; kind: AccountTokenKind; createdBy: string | null; ttlMinutes: number },
): Promise<IssuedAccountToken> {
  const token = randomBase62(ACCOUNT_TOKEN_LENGTH);
  const key = accountTokenKey(token);
  const expiresAt = sql`now() + make_interval(mins => ${input.ttlMinutes})`;
  const row = first(
    await tx
      .insert(accountTokens)
      .values({
        key,
        kind: input.kind,
        userId: input.userId,
        createdBy: input.createdBy,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [accountTokens.userId, accountTokens.kind],
        set: { key, createdBy: input.createdBy, expiresAt, createdAt: sql`now()` },
      })
      .returning({ expiresAt: accountTokens.expiresAt }),
  );
  return { token, expiresAt: row.expiresAt };
}

export interface AccountTokenRow {
  userId: string;
  createdBy: string | null;
  expiresAt: Date;
}

const ROW = {
  userId: accountTokens.userId,
  createdBy: accountTokens.createdBy,
  expiresAt: accountTokens.expiresAt,
};

/** The unexpired link of `kind`, without using it up (an invitation's welcome page). */
export async function peekAccountToken(
  db: Executor,
  raw: unknown,
  kind: AccountTokenKind,
): Promise<AccountTokenRow | null> {
  if (!plausibleAccountToken(raw)) return null;
  const [row] = await db
    .select(ROW)
    .from(accountTokens)
    .where(
      and(
        eq(accountTokens.key, accountTokenKey(raw)),
        eq(accountTokens.kind, kind),
        gt(accountTokens.expiresAt, sql`now()`),
      ),
    );
  return row ?? null;
}

/**
 * Uses the link up: `DELETE … RETURNING` of an unexpired row of `kind`, so of two takers at the
 * same moment only one gets it. A link of another kind is left in place.
 */
export async function takeAccountToken(
  tx: Executor,
  raw: unknown,
  kind: AccountTokenKind,
): Promise<AccountTokenRow | null> {
  if (!plausibleAccountToken(raw)) return null;
  const [row] = await tx
    .delete(accountTokens)
    .where(
      and(
        eq(accountTokens.key, accountTokenKey(raw)),
        eq(accountTokens.kind, kind),
        gt(accountTokens.expiresAt, sql`now()`),
      ),
    )
    .returning(ROW);
  return row ?? null;
}

/** Every link of the user, or those of one kind; how many went. */
export async function deleteAccountTokens(
  tx: Executor,
  userId: string,
  kind?: AccountTokenKind,
): Promise<number> {
  const rows = await tx
    .delete(accountTokens)
    .where(
      kind === undefined
        ? eq(accountTokens.userId, userId)
        : and(eq(accountTokens.userId, userId), eq(accountTokens.kind, kind)),
    )
    .returning({ key: accountTokens.key });
  return rows.length;
}

export type InvitationOf = (userId: string) => { expiresAt: Date } | null;

/** The users' invitations, live or expired (the user DTO's `invitation`), in one query. */
export async function invitationsOf(
  db: Executor,
  userIds: readonly string[],
): Promise<InvitationOf> {
  const rows =
    userIds.length === 0
      ? []
      : await db
          .select({ userId: accountTokens.userId, expiresAt: accountTokens.expiresAt })
          .from(accountTokens)
          .where(
            and(eq(accountTokens.kind, 'invitation'), inArray(accountTokens.userId, [...userIds])),
          );
  const byUser = new Map(rows.map((r) => [r.userId, { expiresAt: r.expiresAt }]));
  return (userId) => byUser.get(userId) ?? null;
}

/**
 * Housekeeping: expired reset links at once, expired invitations EXPIRED_INVITATION_KEPT_DAYS
 * after they expired; in batches, skipping a row a request is taking (`SKIP LOCKED`).
 */
export async function pruneAccountTokens(db: Executor): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await db.execute(sql`
      DELETE FROM account_tokens WHERE key IN (
        SELECT key FROM account_tokens
         WHERE (kind = 'password_reset' AND expires_at <= now())
            OR (kind = 'invitation'
                AND expires_at <= now() - make_interval(days => ${EXPIRED_INVITATION_KEPT_DAYS}))
         LIMIT ${PRUNE_BATCH}
         FOR UPDATE SKIP LOCKED)`);
    const n = result.rowCount ?? 0;
    total += n;
    if (n < PRUNE_BATCH) return total;
  }
}
