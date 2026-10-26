import { PG_CHECK_VIOLATION, pgConstraint, pgErrorCode } from '../src/db/errors';
import type { LlmRequestFeature } from '../src/db/schema';

/*
 * What the tests of a migration's columns and checks share: how a statement the database refused
 * is told apart from one it took, and a row of `llm_requests` of any feature, for the check of the
 * features it takes.
 */

/** PostgreSQL's not_null_violation. */
export const PG_NOT_NULL_VIOLATION = '23502';

/** What a refused statement reports: its SQLSTATE and the constraint that refused it. */
export interface Refusal {
  code: string | undefined;
  constraint: string | undefined;
}

/** The refusal of `action`, or null when it was accepted. */
export const refusal = (action: PromiseLike<unknown>): Promise<Refusal | null> =>
  Promise.resolve(action).then(
    () => null,
    (err: unknown) => ({ code: pgErrorCode(err), constraint: pgConstraint(err) }),
  );

/** The refusal of the named CHECK (23514), not of some other constraint. */
export const checkViolation = (constraint: string): Refusal => ({
  code: PG_CHECK_VIOLATION,
  constraint,
});

/**
 * A row of `llm_requests` of the project for `feature`, whatever the column's type allows: for a
 * value its check must take or refuse. `promptVersion` and the field are the feature's own.
 */
export const llmRequestRow = (
  ids: { organizationId: string; projectId: string },
  feature: string,
  of: { promptVersion: string; field: string },
) => ({
  ...ids,
  feature: feature as LlmRequestFeature,
  cacheKey: 'a'.repeat(64),
  provider: 'openai',
  providerHost: 'api.example.com',
  model: 'm',
  promptVersion: of.promptVersion,
  inputSha256: 'b'.repeat(64),
  inputBytes: 10,
  fields: [of.field],
});
