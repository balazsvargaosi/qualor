import { and, asc, count, desc, eq, gt, lt, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteDeps } from '../app';
import { urlOrigin, type AuditAction, type AuditDetails } from '../audit/catalogue';
import { actorOf, type AuditEventInput } from '../audit/recorder';
import { organizationRef, projectRefs } from '../audit/refs';
import {
  type AccessContext,
  accessOf,
  requireOrganizationAccess,
  requirePermission,
  requireUser,
} from '../auth/access';
import { grantInOrganization, memberOf, organizationFacts } from '../auth/facts';
import { organizationPermissions } from '../auth/policy';
import type { UserPrincipal } from '../auth/principal';
import { randomBase62 } from '../auth/tokens';
import { encryptionKey, encryptSecret } from '../crypto/secrets';
import type { Executor } from '../db/client';
import { first } from '../db/rows';
import {
  memberships,
  organizations,
  projects,
  webhookDeliveries,
  webhookSubscriptions,
} from '../db/schema';
import { decodeCursor, pageQuery, pageSchema, toPage } from '../http/pagination';
import { conflict, notFound, ProblemError, validationFailed } from '../http/problem';
import { idParams, iso, isoOrNull, noContent, noNul, timestamp } from '../http/schemas';
import {
  createDelivery,
  STALLED_DELIVERY_MINUTES,
  DELIVERY_EVENTS,
  WEBHOOK_EVENTS,
  WEBHOOK_SECRET_AAD,
  WEBHOOK_URL_AAD,
  type DeliveryEvent,
  type WebhookEvent,
} from '../webhooks/deliveries';
import {
  canonicalTimeZone,
  chatUrlProblem,
  eventsProblem,
  isChatKind,
  maskChatUrl,
  WEBHOOK_KINDS,
} from '../webhooks/chat/kinds';
import type { ChatTestMessage } from '../webhooks/chat/messages';
import { webhookSettings, webhookUrlProblem } from '../webhooks/url';

type WebhookRow = typeof webhookSubscriptions.$inferSelect;
type DeliveryRow = typeof webhookDeliveries.$inferSelect;

/** A resource bound, not an edition limit: every analysis fans out to at most this many. */
export const MAX_WEBHOOKS_PER_ORGANIZATION = 50;

/**
 * Redelivery bounds, per webhook, so `redeliver` cannot turn the server into a request generator
 * against the target: a redelivery is refused (429 `REDELIVERY_LIMIT_REACHED`) while the webhook
 * has this many pending deliveries (each may retry up to 6 times over about an hour; one whose
 * next attempt is long overdue lost its job and is not counted, see STALLED_DELIVERY_MINUTES) ...
 */
export const MAX_PENDING_DELIVERIES_FOR_REDELIVERY = 5;
/**
 * ... or when this many redeliveries or test messages of it were created in the last hour.
 * Deliveries the ingestion stage creates for a generic webhook are not counted: a busy project
 * does not use up an admin's redeliveries. Such a delivery is created in the transaction its
 * analysis finishes in, so its `created_at` is at most the payload's `finishedAt`; a redelivery
 * copies that payload later. A delivery whose payload has no `finishedAt` counts, which includes
 * every Slack and Teams delivery (their messages carry `at`, not `finishedAt`) and every test.
 */
export const MAX_RECENT_DELIVERIES_FOR_REDELIVERY = 100;
const REDELIVERY_RETRY_AFTER_SECONDS = 60;
/** An ISO 8601 UTC instant as `iso()` writes it, checked before a payload value is cast. */
const ISO_INSTANT = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$`;

/** A generated secret: `whsec_` and 32 base62 characters (about 190 bits). */
function generateSecret(): string {
  return `whsec_${randomBase62(32)}`;
}

const webhookSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  projectId: z.uuid().nullable(),
  kind: z.enum(WEBHOOK_KINDS),
  url: z.string().describe('For Slack and Teams webhooks, the URL masked (it is a secret)'),
  urlMasked: z.boolean(),
  events: z.array(z.enum(WEBHOOK_EVENTS)),
  active: z.boolean(),
  timezone: z.string().describe('The IANA time zone of the weekly digest (Slack and Teams)'),
  createdAt: timestamp,
  updatedAt: timestamp,
});
/** Returned by POST only: a generated secret is shown exactly once. */
const createdWebhookSchema = webhookSchema.extend({ secret: z.string().optional() });
/** Returned by regenerate-secret only: the new secret is shown exactly once. */
const regeneratedWebhookSchema = webhookSchema.extend({ secret: z.string() });

const deliverySchema = z.object({
  id: z.uuid(),
  event: z.enum(DELIVERY_EVENTS),
  status: z.enum(['pending', 'succeeded', 'failed']),
  attempts: z.number().int(),
  responseCode: z.number().int().nullable(),
  responseExcerpt: z.string().nullable(),
  nextAttemptAt: timestamp.nullable(),
  createdAt: timestamp,
});

function webhookDto(row: WebhookRow): z.infer<typeof webhookSchema> {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    kind: row.kind,
    url: row.url,
    urlMasked: row.kind !== 'generic',
    events: row.events as WebhookEvent[],
    active: row.active,
    timezone: row.timezone,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function deliveryDto(row: DeliveryRow): z.infer<typeof deliverySchema> {
  return {
    id: row.id,
    event: row.event as DeliveryEvent,
    status: row.status,
    attempts: row.attempts,
    responseCode: row.responseCode,
    responseExcerpt: row.responseExcerpt,
    nextAttemptAt: isoOrNull(row.nextAttemptAt),
    createdAt: iso(row.createdAt),
  };
}

/** `webhook.created` and `.deleted`: the URL by its origin only, never the secret. */
function webhookAudit(row: WebhookRow): AuditDetails<'webhook.created'> {
  return {
    origin: urlOrigin(row.url),
    projectId: row.projectId,
    events: [...row.events],
    active: row.active,
    kind: row.kind,
  };
}

/** The fields `webhook.updated` names (never their values). */
const WEBHOOK_FIELDS = ['url', 'secret', 'events', 'active', 'timezone'] as const;

const events = z
  .array(z.enum(WEBHOOK_EVENTS))
  .min(1)
  .max(WEBHOOK_EVENTS.length)
  .refine((list) => new Set(list).size === list.length, { message: 'Each event at most once' });
const secret = noNul(z.string().min(16).max(256));
const url = noNul(z.string().min(1).max(2_048));
const timezone = noNul(z.string().min(1).max(64));

/**
 * True when a webhook already has MAX_PENDING_DELIVERIES_FOR_REDELIVERY pending deliveries or
 * MAX_RECENT_DELIVERIES_FOR_REDELIVERY redeliveries or tests in the last hour (see above).
 */
export async function redeliveryBoundsReached(tx: Executor, webhookId: string): Promise<boolean> {
  const bounds = await tx.execute<{ pending: number; recent: number }>(sql`
          SELECT
            (SELECT count(*)::int FROM (
               SELECT 1 FROM webhook_deliveries
                WHERE subscription_id = ${webhookId} AND status = 'pending'
                  AND (next_attempt_at IS NULL
                       OR next_attempt_at >= now() - make_interval(mins => ${STALLED_DELIVERY_MINUTES}))
                LIMIT ${MAX_PENDING_DELIVERIES_FOR_REDELIVERY}) p) AS pending,
            (SELECT count(*)::int FROM (
               SELECT 1 FROM webhook_deliveries
                WHERE subscription_id = ${webhookId} AND created_at > now() - interval '1 hour'
                  AND CASE WHEN payload ->> 'finishedAt' ~ ${ISO_INSTANT}
                           THEN created_at > (payload ->> 'finishedAt')::timestamptz + interval '1 second'
                           ELSE true END
                LIMIT ${MAX_RECENT_DELIVERIES_FOR_REDELIVERY}) r) AS recent`);
  const [counts] = bounds.rows;
  return (
    !counts ||
    counts.pending >= MAX_PENDING_DELIVERIES_FOR_REDELIVERY ||
    counts.recent >= MAX_RECENT_DELIVERIES_FOR_REDELIVERY
  );
}

function redeliveryLimit(action: 'a redelivery' | 'a test message'): ProblemError {
  return new ProblemError(
    429,
    'REDELIVERY_LIMIT_REACHED',
    `A webhook may have at most ${MAX_PENDING_DELIVERIES_FOR_REDELIVERY} pending deliveries, and ${MAX_RECENT_DELIVERIES_FOR_REDELIVERY} deliveries in the last hour, for ${action}; retry later`,
    { headers: { 'retry-after': String(REDELIVERY_RETRY_AFTER_SECONDS) } },
  );
}

/**
 * The webhook named in the path. Every webhook route is 🛡 (api.md §3): a missing webhook and one
 * of an organisation the caller does not belong to are the same 404 (one query, the membership
 * joined); a member who is not an admin gets 403.
 */
async function webhookFor(
  access: AccessContext,
  principal: UserPrincipal,
  id: string,
): Promise<WebhookRow> {
  const [row] = await access.db
    .select({
      webhook: webhookSubscriptions,
      organizationRole: memberships.role,
      hasProjectGrant: grantInOrganization(principal.user, webhookSubscriptions.organizationId),
    })
    .from(webhookSubscriptions)
    .leftJoin(memberships, memberOf(principal.user, webhookSubscriptions.organizationId))
    .where(eq(webhookSubscriptions.id, id));
  if (!row) throw notFound('Webhook');
  const permissions = organizationPermissions(organizationFacts(principal.user, row));
  requirePermission(principal, permissions, 'org.webhooks.manage', 'org.read', 'Webhook');
  return row.webhook;
}

export const webhookRoutes: FastifyPluginAsyncZod<{ deps: RouteDeps }> = async (app, { deps }) => {
  const key = encryptionKey(deps.config.secretKey);
  /**
   * rbac-audit.md §8, §9: one event about `webhook` in the change's transaction `tx`, in its
   * organisation (and its project when it has one); the target's label is the URL's origin.
   */
  const audit = async <A extends AuditAction>(
    tx: Executor,
    request: FastifyRequest,
    webhook: WebhookRow,
    action: A,
    details: AuditDetails<A>,
  ): Promise<void> => {
    if (!deps.audit.active()) return;
    const event = {
      action,
      organization: await organizationRef(tx, webhook.organizationId),
      project:
        webhook.projectId === null ? null : (await projectRefs(tx, webhook.projectId)).project,
      target: { type: 'webhook', id: webhook.id, label: urlOrigin(webhook.url) },
      details,
    } as AuditEventInput;
    await deps.audit.record(tx, actorOf(request), [event]);
  };

  /**
   * 422 on `body.url` unless the URL passes webhookUrlProblem under the instance settings; the
   * WHATWG-normalised form is what is stored (and later checked again and sent).
   */
  const checkedUrl = async (raw: string): Promise<string> => {
    const problem = webhookUrlProblem(raw, await webhookSettings(deps.db));
    if (problem) throw validationFailed([{ path: 'body.url', message: problem }]);
    return new URL(raw).href;
  };

  /**
   * 6G: the stored `url` and `urlEnc` of a URL given for `kind`, after its checks (422 on
   * `body.url`). Generic URLs are stored as they are; a chat URL is a secret (R3), stored
   * encrypted with its masked form in `url`.
   */
  const storedUrl = async (
    kind: WebhookRow['kind'],
    raw: string,
  ): Promise<{ url: string; urlEnc: WebhookRow['urlEnc'] }> => {
    if (!isChatKind(kind)) return { url: await checkedUrl(raw), urlEnc: null };
    const problem = chatUrlProblem(
      kind,
      raw,
      await webhookSettings(deps.db),
      deps.config.chatTestHosts,
    );
    if (problem) throw validationFailed([{ path: 'body.url', message: problem }]);
    const href = new URL(raw).href;
    return { url: maskChatUrl(kind, href), urlEnc: encryptSecret(key, href, WEBHOOK_URL_AAD) };
  };

  /** 422 on `body.timezone` unless the zone is known; its canonical spelling is stored. */
  const checkedZone = (zone: string): string => {
    const canonical = canonicalTimeZone(zone);
    if (canonical === null) {
      throw validationFailed([{ path: 'body.timezone', message: 'Not a known IANA time zone' }]);
    }
    return canonical;
  };

  /** 6G R4: what a kind does not take, as field errors (422). */
  const kindRules = (
    kind: WebhookRow['kind'],
    body: { events?: readonly string[]; secret?: string; timezone?: string },
  ): void => {
    const errors: { path: string; message: string }[] = [];
    const events = body.events === undefined ? null : eventsProblem(kind, body.events);
    if (events) errors.push({ path: 'body.events', message: events });
    if (isChatKind(kind) && body.secret !== undefined) {
      errors.push({ path: 'body.secret', message: 'Slack and Teams webhooks have no secret' });
    }
    if (!isChatKind(kind) && body.timezone !== undefined) {
      errors.push({
        path: 'body.timezone',
        message: 'Only Slack and Teams webhooks have a time zone',
      });
    }
    if (errors.length > 0) throw validationFailed(errors);
  };

  app.get(
    '/webhooks',
    {
      config: { openapi: { problems: [404] } },
      schema: {
        tags: ['webhooks'],
        summary: 'Webhooks of an organisation (org admins)',
        querystring: z.strictObject({ ...pageQuery, organizationId: z.uuid() }),
        response: { 200: pageSchema(webhookSchema) },
      },
    },
    async (request) => {
      const principal = requireUser(request);
      const { organizationId, limit, cursor } = request.query;
      await requireOrganizationAccess(
        accessOf(deps),
        principal,
        organizationId,
        'org.webhooks.manage',
      );
      const after = decodeCursor(cursor);
      const rows = await deps.db
        .select()
        .from(webhookSubscriptions)
        .where(
          and(
            eq(webhookSubscriptions.organizationId, organizationId),
            after ? gt(webhookSubscriptions.id, after) : undefined,
          ),
        )
        .orderBy(asc(webhookSubscriptions.id))
        .limit(limit + 1);
      const page = toPage(rows, limit);
      return { items: page.items.map(webhookDto), nextCursor: page.nextCursor };
    },
  );

  app.post(
    '/webhooks',
    {
      config: { openapi: { problems: [404, 409] } },
      schema: {
        tags: ['webhooks'],
        summary:
          'Create a webhook (generic, Slack or Teams) for an organisation or one of its projects; a generated secret (generic only) is returned once',
        body: z.strictObject({
          organizationId: z.uuid(),
          projectId: z.uuid().nullable().optional(),
          kind: z.enum(WEBHOOK_KINDS).optional(),
          url,
          secret: secret.optional(),
          timezone: timezone.optional(),
          events,
          active: z.boolean().optional(),
        }),
        response: { 201: createdWebhookSchema },
      },
    },
    async (request, reply) => {
      const principal = requireUser(request);
      const body = request.body;
      await requireOrganizationAccess(
        accessOf(deps),
        principal,
        body.organizationId,
        'org.webhooks.manage',
      );
      const kind = body.kind ?? 'generic';
      kindRules(kind, body);
      const zone = body.timezone === undefined ? 'UTC' : checkedZone(body.timezone);
      const stored = await storedUrl(kind, body.url);
      const projectId = body.projectId ?? null;
      if (projectId !== null) {
        const [project] = await deps.db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, projectId), eq(projects.organizationId, body.organizationId)));
        if (!project) {
          throw validationFailed([
            { path: 'body.projectId', message: 'No project of this organisation has this id' },
          ]);
        }
      }
      const generated =
        isChatKind(kind) || body.secret !== undefined ? undefined : generateSecret();
      const plaintext = body.secret ?? generated ?? '';
      const created = await deps.db.transaction(async (tx) => {
        // Serialises concurrent creations for the organisation, so the bound below holds (NO KEY
        // UPDATE: foreign-key checks of unrelated inserts are not blocked).
        await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.id, body.organizationId))
          .for('no key update');
        const [existing] = await tx
          .select({ n: count() })
          .from(webhookSubscriptions)
          .where(eq(webhookSubscriptions.organizationId, body.organizationId));
        if ((existing?.n ?? 0) >= MAX_WEBHOOKS_PER_ORGANIZATION) {
          throw conflict(
            'WEBHOOK_LIMIT_REACHED',
            `An organisation has at most ${MAX_WEBHOOKS_PER_ORGANIZATION} webhooks`,
          );
        }
        const row = first(
          await tx
            .insert(webhookSubscriptions)
            .values({
              organizationId: body.organizationId,
              projectId,
              kind,
              url: stored.url,
              urlEnc: stored.urlEnc,
              secretEnc: isChatKind(kind)
                ? null
                : encryptSecret(key, plaintext, WEBHOOK_SECRET_AAD),
              events: [...body.events],
              active: body.active ?? true,
              timezone: zone,
            })
            .returning(),
        );
        await audit(tx, request, row, 'webhook.created', webhookAudit(row));
        return row;
      });
      return reply.code(201).send({
        ...webhookDto(created),
        ...(generated === undefined ? {} : { secret: generated }),
      });
    },
  );

  app.get(
    '/webhooks/:id',
    {
      schema: {
        tags: ['webhooks'],
        summary: 'A webhook (never its secret)',
        params: idParams,
        response: { 200: webhookSchema },
      },
    },
    async (request) =>
      webhookDto(await webhookFor(accessOf(deps), requireUser(request), request.params.id)),
  );

  app.patch(
    '/webhooks/:id',
    {
      schema: {
        tags: ['webhooks'],
        summary: 'Change the URL, secret (to a provided value), events, active flag or time zone',
        params: idParams,
        body: z
          .strictObject({
            url: url.optional(),
            secret: secret.optional(),
            events: events.optional(),
            active: z.boolean().optional(),
            timezone: timezone.optional(),
          })
          .refine((b) => Object.keys(b).length > 0, { message: 'At least one field is required' }),
        response: { 200: webhookSchema },
      },
    },
    async (request) => {
      const webhook = await webhookFor(accessOf(deps), requireUser(request), request.params.id);
      const body = request.body;
      kindRules(webhook.kind, body);
      const stored = body.url === undefined ? undefined : await storedUrl(webhook.kind, body.url);
      const zone = body.timezone === undefined ? undefined : checkedZone(body.timezone);
      const updated = await deps.db.transaction(async (tx) => {
        const [row] = await tx
          .update(webhookSubscriptions)
          .set({
            ...(stored === undefined ? {} : { url: stored.url, urlEnc: stored.urlEnc }),
            ...(body.secret === undefined
              ? {}
              : { secretEnc: encryptSecret(key, body.secret, WEBHOOK_SECRET_AAD) }),
            ...(body.events === undefined ? {} : { events: [...body.events] }),
            ...(body.active === undefined ? {} : { active: body.active }),
            ...(zone === undefined ? {} : { timezone: zone }),
          })
          .where(eq(webhookSubscriptions.id, webhook.id))
          .returning();
        if (!row) throw notFound('Webhook');
        // Names only: a secret sent is a change, its value never recorded (rbac-audit.md §8).
        const changed = WEBHOOK_FIELDS.filter((field) => {
          if (field === 'secret') return body.secret !== undefined;
          if (field === 'events') return row.events.join(',') !== webhook.events.join(',');
          // A chat URL is a secret: sending one is a change even when its masked form is equal.
          if (field === 'url') {
            return stored !== undefined && (isChatKind(row.kind) || row.url !== webhook.url);
          }
          return row[field] !== webhook[field];
        });
        if (changed.length > 0) await audit(tx, request, row, 'webhook.updated', { changed });
        return row;
      });
      return webhookDto(updated);
    },
  );

  app.post(
    '/webhooks/:id/regenerate-secret',
    {
      config: { openapi: { problems: [404, 409] } },
      schema: {
        tags: ['webhooks'],
        summary: 'Replace the secret with a generated one, returned once in this response',
        params: idParams,
        response: { 200: regeneratedWebhookSchema },
      },
    },
    async (request) => {
      const webhook = await webhookFor(accessOf(deps), requireUser(request), request.params.id);
      if (isChatKind(webhook.kind)) {
        throw conflict('WEBHOOK_HAS_NO_SECRET', 'Slack and Teams webhooks have no secret');
      }
      const generated = generateSecret();
      const updated = await deps.db.transaction(async (tx) => {
        const [row] = await tx
          .update(webhookSubscriptions)
          .set({ secretEnc: encryptSecret(key, generated, WEBHOOK_SECRET_AAD) })
          .where(eq(webhookSubscriptions.id, webhook.id))
          .returning();
        if (!row) throw notFound('Webhook');
        await audit(tx, request, row, 'webhook.secret_regenerated', {});
        return row;
      });
      return { ...webhookDto(updated), secret: generated };
    },
  );

  app.delete(
    '/webhooks/:id',
    {
      schema: {
        tags: ['webhooks'],
        summary: 'Delete a webhook and its delivery history; pending attempts stop',
        params: idParams,
        response: { 204: noContent },
      },
    },
    async (request, reply) => {
      const webhook = await webhookFor(accessOf(deps), requireUser(request), request.params.id);
      await deps.db.transaction(async (tx) => {
        const [deleted] = await tx
          .delete(webhookSubscriptions)
          .where(eq(webhookSubscriptions.id, webhook.id))
          .returning();
        if (deleted) await audit(tx, request, deleted, 'webhook.deleted', webhookAudit(deleted));
      });
      return reply.code(204).send();
    },
  );

  app.get(
    '/webhooks/:id/deliveries',
    {
      schema: {
        tags: ['webhooks'],
        summary: 'Recent deliveries, newest first (kept 30 days)',
        params: idParams,
        querystring: z.strictObject(pageQuery),
        response: { 200: pageSchema(deliverySchema) },
      },
    },
    async (request) => {
      const webhook = await webhookFor(accessOf(deps), requireUser(request), request.params.id);
      const before = decodeCursor(request.query.cursor);
      const rows = await deps.db
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.subscriptionId, webhook.id),
            before ? lt(webhookDeliveries.id, before) : undefined,
          ),
        )
        .orderBy(desc(webhookDeliveries.id))
        .limit(request.query.limit + 1);
      const page = toPage(rows, request.query.limit);
      return { items: page.items.map(deliveryDto), nextCursor: page.nextCursor };
    },
  );

  app.post(
    '/webhooks/:id/deliveries/:deliveryId/redeliver',
    {
      config: { openapi: { problems: [404, 429] } },
      schema: {
        tags: ['webhooks'],
        summary:
          'Send a delivery again, as a new delivery with the same event and payload (bounded per webhook)',
        params: z.strictObject({ id: z.uuid(), deliveryId: z.uuid() }),
        response: { 202: deliverySchema },
      },
    },
    async (request, reply) => {
      const webhook = await webhookFor(accessOf(deps), requireUser(request), request.params.id);
      const redelivered = await deps.db.transaction(async (tx) => {
        // Serialises redeliveries of this webhook, so the bounds below hold under concurrency (NO
        // KEY UPDATE: ingestion's delivery inserts only take KEY SHARE through the foreign key).
        const [locked] = await tx
          .select({ id: webhookSubscriptions.id })
          .from(webhookSubscriptions)
          .where(eq(webhookSubscriptions.id, webhook.id))
          .for('no key update');
        if (!locked) throw notFound('Webhook');
        const [original] = await tx
          .select()
          .from(webhookDeliveries)
          .where(
            and(
              eq(webhookDeliveries.id, request.params.deliveryId),
              eq(webhookDeliveries.subscriptionId, webhook.id),
            ),
          );
        if (!original) throw notFound('Delivery');
        if (await redeliveryBoundsReached(tx, webhook.id)) throw redeliveryLimit('a redelivery');
        const id = await createDelivery(tx, {
          subscriptionId: webhook.id,
          event: original.event as DeliveryEvent,
          payload: original.payload,
        });
        const created = first(
          await tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)),
        );
        // The delivery the person asked to send again (the path's), and its event.
        await audit(tx, request, webhook, 'webhook.redelivered', {
          deliveryId: original.id,
          event: original.event,
        });
        return created;
      });
      return reply.code(202).send(deliveryDto(redelivered));
    },
  );

  app.post(
    '/webhooks/:id/test',
    {
      config: { openapi: { problems: [404, 409, 429] } },
      schema: {
        tags: ['webhooks'],
        summary:
          'Send a test message to a Slack or Teams webhook (a delivery like any other; bounded like redeliveries)',
        params: idParams,
        response: { 202: deliverySchema },
      },
    },
    async (request, reply) => {
      const webhook = await webhookFor(accessOf(deps), requireUser(request), request.params.id);
      if (!isChatKind(webhook.kind)) {
        throw conflict(
          'WEBHOOK_TEST_CHAT_ONLY',
          'Only Slack and Teams webhooks have a test message',
        );
      }
      if (!webhook.active) {
        throw conflict('WEBHOOK_INACTIVE', 'Switch the webhook on to send a test message');
      }
      const queued = await deps.db.transaction(async (tx) => {
        // The same serialisation as a redelivery, so the bounds hold under concurrency.
        const [locked] = await tx
          .select({ id: webhookSubscriptions.id })
          .from(webhookSubscriptions)
          .where(eq(webhookSubscriptions.id, webhook.id))
          .for('no key update');
        if (!locked) throw notFound('Webhook');
        if (await redeliveryBoundsReached(tx, webhook.id)) throw redeliveryLimit('a test message');
        // The names the message shows (audit refs carry keys only).
        const [organization] = await tx
          .select({ name: organizations.name })
          .from(organizations)
          .where(eq(organizations.id, webhook.organizationId));
        const [project] =
          webhook.projectId === null
            ? [undefined]
            : await tx
                .select({ id: projects.id, name: projects.name })
                .from(projects)
                .where(eq(projects.id, webhook.projectId));
        const payload: ChatTestMessage = {
          type: 'test',
          organization: { id: webhook.organizationId, name: organization?.name ?? '' },
          project: project === undefined ? null : { id: project.id, name: project.name },
        };
        const id = await createDelivery(tx, {
          subscriptionId: webhook.id,
          event: 'chat.test',
          payload,
        });
        return first(await tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)));
      });
      return reply.code(202).send(deliveryDto(queued));
    },
  );
};
