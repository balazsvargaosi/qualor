import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteDeps } from '../app';
import { actorOf } from '../audit/recorder';
import { requireInstanceAdmin } from '../auth/access';
import { mcpPolicySchema, readMcpPolicy, writeMcpPolicy, type McpPolicy } from '../oauth/policy';
import { mcpUrls } from '../oauth/urls';

const settingsSchema = z.object({
  enabled: z.boolean(),
  reason: z.enum(['PUBLIC_URL_MISSING']).nullable(),
  url: z.string().nullable(),
  policy: mcpPolicySchema,
});

/** Spec §9: Settings → MCP, for the instance administrator. */
export const mcpSettingsRoutes: FastifyPluginAsyncZod<{ deps: RouteDeps }> = async (
  app,
  { deps },
) => {
  const view = (policy: McpPolicy): z.infer<typeof settingsSchema> => {
    const urls = mcpUrls(deps.config.publicUrl);
    return {
      enabled: urls !== null,
      reason: urls ? null : 'PUBLIC_URL_MISSING',
      url: urls?.resource ?? null,
      policy,
    };
  };

  app.get(
    '/system/mcp',
    {
      schema: {
        tags: ['system'],
        summary: 'The MCP endpoint and its client policy',
        response: { 200: settingsSchema },
      },
    },
    async (request) => {
      requireInstanceAdmin(request);
      return view(await readMcpPolicy(deps.db));
    },
  );

  app.put(
    '/system/mcp',
    {
      schema: {
        tags: ['system'],
        summary: 'Change which OAuth clients may connect to the MCP endpoint',
        body: mcpPolicySchema,
        response: { 200: settingsSchema },
      },
    },
    async (request) => {
      requireInstanceAdmin(request);
      const policy = request.body;
      await deps.db.transaction(async (tx) => {
        await writeMcpPolicy(tx, policy);
        await deps.audit.record(tx, actorOf(request), [
          {
            action: 'oauth.settings_changed',
            target: { type: 'mcp_settings', id: 'mcp' },
            details: {
              dcr: policy.dcr,
              cimd: policy.cimd,
              allowedClients: policy.allowedClients.length,
            },
          },
        ]);
      });
      return view(policy);
    },
  );
};
