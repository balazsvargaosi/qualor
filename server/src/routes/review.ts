import { MAX_SNAPSHOT_FILE_BYTES, MAX_SNAPSHOT_FILES } from '@qualor/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteDeps } from '../app';
import { actorOf } from '../audit/recorder';
import { accessOf, requireOrganizationAccess, requirePrincipal, requireUser } from '../auth/access';
import { organizations } from '../db/schema';
import { retentionSettings } from '../housekeeping/run';
import { conflict, ProblemError, type FieldError } from '../http/problem';
import { idParams } from '../http/schemas';
import { lockLlmSettings } from '../llm/auto-fix-settings';
import {
  organizationSettings,
  projectOwners,
  readLlmSettings,
  writeLlmSettings,
  type StoredLlmSettings,
} from '../llm/settings';
import { PROJECT_KEY_PATTERN } from '../patterns';
import { projectForUpload } from '../projects/access';
import {
  consentCurrent,
  dataSharingNotice,
  MAX_REVIEW_PROJECT_IDS,
  REVIEW_INACTIVE_REASONS,
  REVIEW_SCOPES,
  reviewActive,
  reviewBudgetsSchema,
  reviewConsentSchema,
  reviewProvider,
  reviewSettingsOf,
  sameReview,
  withOrganizationReview,
  type ReviewSettings,
} from '../review/settings';

/**
 * The project DTO's `aiReview` (6I-2): whether AI review runs for the project, and whether its
 * organisation has it on, so the project settings can say who switches it on.
 */
export const projectAiReviewSchema = z.object({
  /**
   * AI review is on for the project: the organisation has it on (a provider configured, the
   * organisation enabled for the AI assistant, review switched on with a consent that covers the
   * provider) and selects the project (the scope `all`, or the project listed), and does not
   * exclude it from the AI assistant. Whether the project is mapped to an SCM connection is not
   * part of it: `GET /projects/review-context` says so.
   */
  enabled: z.boolean(),
  /** The organisation has AI review on, as above, whichever projects it selects. */
  organizationEnabled: z.boolean(),
});

/** `GET`/`PUT /organizations/{id}/ai/review` (6I-2, spec C1, D4, R10). */
export const organizationReviewSchema = z.object({
  /** AI review can be switched on: a provider is configured and the organisation is enabled. */
  available: z.boolean(),
  unavailableReason: z.enum(['no_provider', 'organization_disabled']).nullable(),
  /** The configured provider as the notice names it (its host includes the port); null without one. */
  provider: z.object({ host: z.string(), model: z.string() }).nullable(),
  /** The data-sharing warning to show to whoever switches review on, word for word; null without a provider. */
  notice: z.string().nullable(),
  enabled: z.boolean(),
  scope: z.enum(REVIEW_SCOPES),
  /** The projects of the scope `selected` (kept while the scope is `all`); deleted projects are left out. */
  projectIds: z.array(z.uuid()),
  /** The organisation's own budgets; the instance ceiling caps `tokensPerDay` when a review runs. */
  budgets: reviewBudgetsSchema,
  /** Who acknowledged the notice, for which provider host and model, and when; null before any. */
  consent: reviewConsentSchema.nullable(),
  /** The consent names the configured provider's host and model; false after either changed (R10). */
  consentCurrent: z.boolean(),
  instanceCeiling: z.object({
    /** The most tokens per organisation per day the instance administrator allows; null: none. */
    tokensPerDay: z.number().int().nullable(),
  }),
});
type OrganizationReview = z.infer<typeof organizationReviewSchema>;

const reviewBody = z.strictObject({
  enabled: z.boolean(),
  scope: z.enum(REVIEW_SCOPES),
  projectIds: z.array(z.uuid()).max(MAX_REVIEW_PROJECT_IDS),
  budgets: reviewBudgetsSchema,
  acknowledgeDataSharing: z.boolean().optional().meta({
    description:
      'true confirms the notice in the answer. Needed to switch review on from off, and while consentCurrent is false; ignored otherwise',
  }),
});

const reviewContextSchema = z.object({
  /** The scanner should upload a repository snapshot of the merge request. */
  review: z.boolean(),
  /** Why not, when `review` is false. */
  reason: z.enum(REVIEW_INACTIVE_REASONS).nullable(),
  /** The commit of this merge request the last review covered; always null before the review itself exists. */
  lastReviewedCommit: z.string().nullable(),
  /** The snapshot limits this server accepts: the scanner stays within them. */
  limits: z.object({
    maxCompressedBytes: z.number().int(),
    maxDecompressedBytes: z.number().int(),
    maxFileBytes: z.number().int(),
    maxFiles: z.number().int(),
  }),
});

const FOREIGN_PROJECT_TEXT = 'Not a project of this organisation';

/** The answer for the organisation: `projectIds` are those of its projects that still exist. */
function organizationReview(
  settings: StoredLlmSettings,
  organizationId: string,
  retentionDays: number,
  projectIds: readonly string[],
): OrganizationReview {
  const provider = reviewProvider(settings);
  const organization = organizationSettings(settings, organizationId);
  const unavailableReason =
    provider === null ? 'no_provider' : organization.enabled ? null : 'organization_disabled';
  const review = organization.review;
  return {
    available: unavailableReason === null,
    unavailableReason,
    provider,
    notice:
      provider === null ? null : dataSharingNotice(provider.host, provider.model, retentionDays),
    enabled: review.enabled,
    scope: review.scope,
    projectIds: [...projectIds],
    budgets: review.budgets,
    consent: review.consent,
    consentCurrent: consentCurrent(settings, review),
    instanceCeiling: { tokensPerDay: settings.budgets.reviewTokensPerOrganizationPerDay },
  };
}

/**
 * AI review (6I-2): an organisation admin switches it on for the organisation, acknowledging that
 * repository code goes to the instance's AI provider (D4, C1); the scanner asks whether to upload
 * a snapshot. The provider and the organisation's enablement stay the instance admin's
 * (`/system/llm`, llm.md §3.1).
 */
export const reviewRoutes: FastifyPluginAsyncZod<{ deps: RouteDeps }> = async (app, { deps }) => {
  app.get(
    '/organizations/:id/ai/review',
    {
      schema: {
        tags: ['ai'],
        summary:
          "The organisation's AI review settings and the data-sharing notice (org.ai.manage); `available` is false without a provider or an enabled organisation",
        params: idParams,
        response: { 200: organizationReviewSchema },
      },
    },
    async (request) => {
      const principal = requireUser(request);
      const organizationId = request.params.id;
      await requireOrganizationAccess(accessOf(deps), principal, organizationId, 'org.ai.manage');
      const [settings, retention] = await Promise.all([
        readLlmSettings(deps.db),
        retentionSettings(deps.db),
      ]);
      // llm.md §3.3: the id of a project deleted since is left out.
      const listed = reviewSettingsOf(settings, organizationId).projectIds;
      const owners = await projectOwners(deps.db, listed);
      return organizationReview(
        settings,
        organizationId,
        retention.reviewSnapshotsDays,
        listed.filter((id) => owners.get(id) === organizationId),
      );
    },
  );

  app.put(
    '/organizations/:id/ai/review',
    {
      config: {
        openapi: {
          problems: [409],
          problemDescriptions: {
            403: 'FORBIDDEN or INSUFFICIENT_SCOPE',
            409: 'AI_DISABLED (switching it on needs a provider and the organisation enabled for the AI assistant), or AI_REVIEW_CONSENT_REQUIRED (switching it on, from off or while consentCurrent is false, needs acknowledgeDataSharing: true)',
            422: 'VALIDATION_FAILED, or PROJECT_NOT_IN_ORGANIZATION (a project id belongs to another organisation; errors[] names it)',
          },
        },
      },
      schema: {
        tags: ['ai'],
        summary:
          "Set the organisation's AI review (org.ai.manage). Switching it on needs acknowledgeDataSharing: true, which records the provider's host and model, the user and the time; a change of the provider's host or model makes the consent outdated until it is given again",
        params: idParams,
        body: reviewBody,
        response: { 200: organizationReviewSchema },
      },
    },
    async (request) => {
      const principal = requireUser(request);
      const organizationId = request.params.id;
      const organization = await requireOrganizationAccess(
        accessOf(deps),
        principal,
        organizationId,
        'org.ai.manage',
      );
      const body = request.body;
      const retentionDays = (await retentionSettings(deps.db)).reviewSnapshotsDays;
      return deps.db.transaction(async (tx): Promise<OrganizationReview> => {
        const settings = await lockLlmSettings(tx);
        const current = reviewSettingsOf(settings, organizationId);
        // UUIDs compare in lower case, as the database returns them.
        const requested = body.projectIds.map((id) => id.toLowerCase());
        const owners = await projectOwners(tx, [...requested, ...current.projectIds]);
        const foreign: FieldError[] = requested.flatMap((id, i) => {
          const owner = owners.get(id);
          return owner !== undefined && owner !== organizationId
            ? [{ path: `body.projectIds.${i}`, message: FOREIGN_PROJECT_TEXT }]
            : [];
        });
        if (foreign.length > 0) {
          throw new ProblemError(
            422,
            'PROJECT_NOT_IN_ORGANIZATION',
            'Some of the projects belong to another organisation',
            { errors: foreign },
          );
        }
        // llm.md §3.3: each project once, in order; the id of a project deleted since is dropped.
        const ownProjects = (ids: readonly string[]): string[] =>
          [...new Set(ids)].filter((id) => owners.get(id) === organizationId).sort();
        const stored: ReviewSettings = { ...current, projectIds: ownProjects(current.projectIds) };
        const provider = reviewProvider(settings);
        // Switching it on: from off, or confirming again when the provider's host or model changed.
        const switchingOn =
          body.enabled && (!current.enabled || !consentCurrent(settings, current));
        let consent = current.consent;
        if (switchingOn) {
          if (provider === null || !organizationSettings(settings, organizationId).enabled) {
            throw conflict(
              'AI_DISABLED',
              'AI review needs the AI assistant configured and enabled for this organisation',
            );
          }
          if (body.acknowledgeDataSharing !== true) {
            throw conflict(
              'AI_REVIEW_CONSENT_REQUIRED',
              'Switching AI review on needs the data-sharing notice acknowledged',
            );
          }
          consent = {
            providerHost: provider.host,
            model: provider.model,
            userId: principal.user.id,
            at: new Date().toISOString(),
          };
        }
        const next: ReviewSettings = {
          enabled: body.enabled,
          scope: body.scope,
          projectIds: ownProjects(requested),
          budgets: body.budgets,
          consent,
        };
        // Nothing to save: the stored block already holds these values.
        if (sameReview(current, next)) {
          return organizationReview(settings, organizationId, retentionDays, next.projectIds);
        }
        const saved = withOrganizationReview(settings, organizationId, next);
        await writeLlmSettings(tx, saved);
        // The audit event names a change a person can see: the ids of deleted projects, which a
        // save drops, are not one (nor is the same save again).
        if (!sameReview(stored, next) && deps.audit.active()) {
          const [row] = await tx
            .select({ name: organizations.name })
            .from(organizations)
            .where(eq(organizations.id, organizationId));
          await deps.audit.record(tx, actorOf(request), [
            {
              action: 'organization.ai_review_changed',
              organization: { id: organizationId, key: organization.organizationKey },
              target: { type: 'organization', id: organizationId, label: row?.name ?? null },
              details: {
                enabled: next.enabled,
                scope: next.scope,
                projects: next.projectIds.length,
                consentGiven: switchingOn,
                providerHost: provider?.host ?? null,
                model: provider?.model ?? null,
              },
            },
          ]);
        }
        return organizationReview(saved, organizationId, retentionDays, next.projectIds);
      });
    },
  );

  app.get(
    '/projects/review-context',
    {
      config: {
        openapi: {
          problems: [404],
          problemDescriptions: {
            404: 'PROJECT_NOT_FOUND: the project does not exist, the token belongs to another project, or the caller cannot see it (a server without this route answers NOT_FOUND)',
          },
        },
      },
      schema: {
        tags: ['projects'],
        summary:
          'Whether the scanner should upload a repository snapshot of a merge request (AI review is on for the project), and the limits of a snapshot; the CLI calls this before a merge request scan uploads',
        querystring: z.strictObject({
          projectKey: z.string().regex(PROJECT_KEY_PATTERN),
          // The merge request's number. The last reviewed commit of that merge request will be
          // answered from it; until the review exists `lastReviewedCommit` is null.
          mergeRequest: z.string().regex(/^[0-9]{1,10}$/),
        }),
        response: { 200: reviewContextSchema },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      const project = await projectForUpload(accessOf(deps), principal, request.query.projectKey);
      const verdict = reviewActive(await readLlmSettings(deps.db), project);
      return {
        review: verdict.active,
        reason: verdict.active ? null : verdict.reason,
        lastReviewedCommit: null,
        limits: {
          maxCompressedBytes: deps.config.reviewSnapshot.maxCompressedBytes,
          maxDecompressedBytes: deps.config.reviewSnapshot.maxDecompressedBytes,
          maxFileBytes: MAX_SNAPSHOT_FILE_BYTES,
          maxFiles: MAX_SNAPSHOT_FILES,
        },
      };
    },
  );
};
