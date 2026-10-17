import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteDeps } from '../app';
import { actorOf } from '../audit/recorder';
import { requireSession } from '../auth/access';
import { forbidden, notFound, validationFailed } from '../http/problem';
import { idParams, timestamp } from '../http/schemas';
import { decide, pendingRequestFor } from '../oauth/grants';
import { MCP_SCOPES } from '../oauth/tokens';
import { mcpUrls } from '../oauth/urls';

const scope = z.enum(MCP_SCOPES);
const pendingSchema = z.object({
  id: z.uuid(),
  client: z.object({
    clientId: z.string(),
    name: z.string(),
    source: z.enum(['cimd', 'dcr']),
    logoUri: z.string().nullable(),
    clientUri: z.string().nullable(),
    redirectTarget: z.string(),
    redirectUri: z.string(),
  }),
  scopes: z.array(scope),
  expiresAt: timestamp,
  coveredByGrant: z.boolean(),
});

/** Spec §6 step 6: what the consent screen reads and answers; a browser session only. */
export const oauthConsentRoutes: FastifyPluginAsyncZod<{ deps: RouteDeps }> = async (
  app,
  { deps },
) => {
  const issuer = () => mcpUrls(deps.config.publicUrl)?.issuer ?? null;

  /**
   * Reading binds the request to the caller: the first signed-in user to open it is the only one
   * who can see or answer it afterwards (intended, spec §6 step 5).
   */
  app.get(
    '/oauth/requests/:id',
    {
      config: { openapi: { problems: [404] } },
      schema: {
        tags: ['oauth'],
        summary: 'A pending OAuth authorization request',
        params: idParams,
        response: { 200: pendingSchema },
      },
    },
    async (request) => {
      const principal = requireSession(request);
      if (!issuer()) throw notFound('Authorization request');
      const view = await pendingRequestFor(deps.db, request.params.id, principal.user.id);
      if (!view) throw notFound('Authorization request');
      return { ...view, expiresAt: view.expiresAt.toISOString() };
    },
  );

  app.post(
    '/oauth/requests/:id/decision',
    {
      config: { openapi: { problems: [404] } },
      schema: {
        tags: ['oauth'],
        summary: 'Approve or deny a pending OAuth authorization request',
        params: idParams,
        body: z.discriminatedUnion('decision', [
          z.strictObject({ decision: z.literal('approve'), scopes: z.array(scope).min(1).max(2) }),
          z.strictObject({ decision: z.literal('deny') }),
        ]),
        response: { 200: z.object({ redirectTo: z.string() }) },
      },
    },
    async (request) => {
      const principal = requireSession(request);
      const iss = issuer();
      if (!iss) throw notFound('Authorization request');
      const body = request.body;
      const result = await decide(
        deps.db,
        request.params.id,
        principal.user.id,
        body.decision === 'approve' ? { approve: true, scopes: body.scopes } : { approve: false },
        iss,
        // In the grant's transaction: the event commits or rolls back with it.
        (tx, grant) =>
          deps.audit.record(tx, actorOf(request), [
            {
              action: 'oauth.grant_created',
              target: { type: 'oauth_grant', id: grant.id, label: grant.clientName },
              details: {
                clientId: grant.clientId,
                clientName: grant.clientName,
                scopes: grant.scopes,
              },
            },
          ]),
      );
      if (!result.ok && result.reason === 'scope_not_requested') {
        throw validationFailed([
          { path: 'body.scopes', message: 'Only the scopes the client asked for' },
        ]);
      }
      if (!result.ok && result.reason === 'client_not_allowed') {
        throw forbidden('CLIENT_NOT_ALLOWED', 'The administrator no longer allows this client');
      }
      if (!result.ok) throw notFound('Authorization request');
      return { redirectTo: result.redirectTo };
    },
  );
};
