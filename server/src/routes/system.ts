import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RouteDeps } from '../app';
import { requirePrincipal, requireUser } from '../auth/access';
import { ProblemError } from '../http/problem';
import { mcpUrls } from '../oauth/urls';
import { VERSION } from '../index';

const status = z.object({ status: z.literal('ok') });

/** `/readyz` answers 503 when the database has not answered within this time. */
export const READY_TIMEOUT_MS = 2_000;

export const systemRoutes: FastifyPluginAsyncZod<{ deps: RouteDeps }> = async (app, { deps }) => {
  app.get(
    '/healthz',
    {
      config: { public: true },
      schema: {
        tags: ['system'],
        summary: 'Liveness (no database access)',
        security: [],
        response: { 200: status },
      },
    },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/readyz',
    {
      config: { public: true },
      schema: {
        tags: ['system'],
        summary: 'Database reachable and migrations current',
        security: [],
        response: { 200: status },
      },
    },
    async () => {
      let ready: boolean;
      let timer: NodeJS.Timeout | undefined;
      try {
        // An unresponsive PostgreSQL must not hang the health check (and the probe behind it).
        const timeout = new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), deps.readyTimeoutMs ?? READY_TIMEOUT_MS);
        });
        ready = await Promise.race([deps.checkReady(), timeout]);
      } catch {
        ready = false;
      } finally {
        clearTimeout(timer);
      }
      if (!ready)
        throw new ProblemError(
          503,
          'NOT_READY',
          'The database is unreachable or migrations are pending',
        );
      return { status: 'ok' as const };
    },
  );

  app.get(
    '/api/v0/system/info',
    {
      schema: {
        tags: ['system'],
        summary: 'Version, edition, active plugin features, UI extensions and the MCP server',
        response: {
          200: z.object({
            version: z.string(),
            edition: z.enum(['community', 'enterprise']),
            features: z.array(z.string()),
            extensions: z.array(
              z.object({
                point: z.enum(['settings.nav', 'project.tab', 'main.nav']),
                id: z.string(),
                label: z.string(),
                path: z.string(),
              }),
            ),
            mcp: z
              .object({
                enabled: z.boolean(),
                reason: z.enum(['PUBLIC_URL_MISSING']).nullable(),
              })
              .describe(
                'Whether /mcp and the OAuth endpoints are on (they need QUALOR_PUBLIC_URL)',
              ),
          }),
        },
      },
    },
    async (request) => {
      requireUser(request);
      return {
        version: VERSION,
        edition: deps.edition.edition(),
        features: deps.edition.activeFeatures(),
        extensions: deps.edition.uiExtensions(),
        mcp:
          mcpUrls(deps.config.publicUrl) === null
            ? { enabled: false, reason: 'PUBLIC_URL_MISSING' as const }
            : { enabled: true, reason: null },
      };
    },
  );

  // Any authenticated caller, a project analysis token too: the scanner logs the server's version
  // when a scan starts, warns when its own release differs, and logs `latest` (telemetry.md
  // "Update check"). Anonymous callers learn nothing.
  app.get(
    '/api/v0/system/version',
    {
      schema: {
        tags: ['system'],
        summary: "The server's version, for any token (the scanner checks it when a scan starts)",
        response: {
          200: z.object({
            version: z.string(),
            latest: z
              .string()
              .optional()
              .describe('A newer release found on Docker Hub; only while telemetry is on'),
          }),
        },
      },
    },
    async (request) => {
      requirePrincipal(request);
      const latest = deps.updates?.latest() ?? null;
      return latest === null ? { version: VERSION } : { version: VERSION, latest };
    },
  );

  app.get('/api/v0/openapi.json', { config: { public: true }, schema: { hide: true } }, async () =>
    app.swagger(),
  );
};
