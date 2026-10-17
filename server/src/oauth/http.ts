import type { FastifyInstance, FastifyReply } from 'fastify';

export const DUPLICATE = Symbol('duplicate parameter');
export type FormBody = Record<string, string | typeof DUPLICATE>;

/** RFC 6749 §5.2 error JSON; never cached. */
export function oauthError(
  reply: FastifyReply,
  status: number,
  error: string,
  description: string,
): FastifyReply {
  return reply
    .code(status)
    .header('cache-control', 'no-store')
    .header('pragma', 'no-cache')
    .send({ error, error_description: description });
}

/** RFC 6749 §3.2: form bodies; a parameter sent twice is an error the handler reports. */
export function installFormParser(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 16 * 1024 },
    (_request, body, done) => {
      const out: FormBody = Object.create(null) as FormBody;
      for (const [key, value] of new URLSearchParams(body as string)) {
        out[key] = Object.hasOwn(out, key) ? DUPLICATE : value;
      }
      done(null, out);
    },
  );
}

/** One string parameter, or null when missing, repeated or not a string. */
export function param(body: unknown, name: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : null;
}

export function hasDuplicate(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    Object.values(body as Record<string, unknown>).includes(DUPLICATE)
  );
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers':
    'authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id',
  'access-control-expose-headers': 'www-authenticate, mcp-session-id, mcp-protocol-version',
  'access-control-max-age': '600',
};

/** Ruling R7: credential-less CORS on the endpoints browser-based clients call. */
export function installCors(app: FastifyInstance, matches: (url: string) => boolean): void {
  app.addHook('onSend', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if (matches(path)) void reply.headers(CORS_HEADERS);
  });
}

export function corsPreflight(reply: FastifyReply): FastifyReply {
  return reply.code(204).headers(CORS_HEADERS).send();
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A page that never redirects: the client or its redirect URI could not be trusted. */
export function errorPage(
  reply: FastifyReply,
  status: number,
  title: string,
  message: string,
): FastifyReply {
  return reply
    .code(status)
    .type('text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .send(
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escape(title)}</title>` +
        `<body><h1>${escape(title)}</h1><p>${escape(message)}</p></body></html>`,
    );
}
