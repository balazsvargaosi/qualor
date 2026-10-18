import type { FastifyInstance } from 'fastify';
import type { OAuthPrincipal } from '../auth/principal';
import type { TokenScope } from '../db/schema';
import { cleanClientName } from '../oauth/clients';
import { INTERNAL_HEADER } from './internal';
import { ToolError, type ToolAccess } from './tool';

export type CallResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; code: string; title: string; detail: unknown };

export type Query = Record<string, string | number | boolean | string[] | undefined>;

/** A tool's way to the REST API: in-process, as its principal, within its access (spec §4.4). */
export interface McpCaller {
  get<T>(path: string, query?: Query): Promise<CallResult<T>>;
  post<T>(path: string, body: unknown): Promise<CallResult<T>>;
}

const SEGMENT = '[^/?#]+';
const AI_POST = new RegExp(`^/api/v0/issues/${SEGMENT}/ai/(explain|fix)$`);
const WRITE_POST = new RegExp(`^/api/v0/issues/${SEGMENT}/transition$`);
/** Plain segments only: no query, fragment, empty segment or anything a router would rewrite. */
const SAFE_PATH = /^\/api\/v0(\/[A-Za-z0-9._~%:@-]+)+$/;

/**
 * Review Focus 3, ruling R1: every tool may GET under /api/v0; an AI tool may also POST an issue's
 * explain or fix, the write tool a single issue's transition, a read tool nothing else. A path
 * outside /api/v0, or one with a `..`, `//` or an escaped `.`/`/`, is never allowed. The caller
 * treats a refused route as a programming error.
 */
export function routeAllowed(access: ToolAccess, method: 'GET' | 'POST', path: string): boolean {
  if (!SAFE_PATH.test(path) || path.includes('..')) return false;
  for (const segment of path.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (decoded === '.' || decoded.includes('..') || /[/\\]/.test(decoded)) return false;
  }
  if (method === 'GET') return true;
  if (access === 'ai') return AI_POST.test(path);
  if (access === 'write') return WRITE_POST.test(path);
  return false;
}

/**
 * Spec §4.3: the REST scopes an internal call runs with (ranked: `write` covers `read`). A read
 * tool's calls are `read`; an AI tool's explain and fix and the transition need `write`, which
 * `routeAllowed` has already narrowed to those routes.
 */
const SCOPES: Record<ToolAccess, TokenScope[]> = {
  read: ['read'],
  ai: ['write'],
  write: ['write'],
};

/** Names are cleaned when stored too; this guards rows stored before that (and any other path). */
export { cleanClientName };

/** The cleaned client name, or `unnamed client` when nothing printable is left. */
export function clientLabel(clientName: string): string {
  return cleanClientName(clientName) || 'unnamed client';
}

/** The user agent of an internal call: `qualor-mcp (<client label>)`. */
export function mcpUserAgent(clientName: string): string {
  return `qualor-mcp (${clientLabel(clientName)})`;
}

/** Repeated keys for arrays: the issue list's `many(...)` filters parse repeated parameters. */
export function queryString(query: Query = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) q.append(k, item);
    else q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

function parseBody(body: string, contentType: string | undefined): unknown {
  if (!body) return {};
  if (!contentType?.includes('json')) return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

/**
 * Ruling R4: each call injects the request with a fresh one-time key for `principal` carrying the
 * tool's REST scopes, so every RBAC, visibility, edition and audit rule of the route runs as for
 * the user's own token. The client address and a user agent naming the client go along for the
 * audit log and the rate limits.
 */
export function callerFor(
  app: FastifyInstance,
  principal: Omit<OAuthPrincipal, 'scopes'>,
  access: ToolAccess,
  remoteAddress: string,
  userAgent: string,
): McpCaller {
  const send = async <T>(
    method: 'GET' | 'POST',
    path: string,
    query: string,
    body?: unknown,
  ): Promise<CallResult<T>> => {
    if (!routeAllowed(access, method, path)) {
      throw new Error(`MCP tool with ${access} access tried ${method} ${path}`);
    }
    const key = app.internalCalls.issue({ ...principal, scopes: SCOPES[access] });
    const res = await app.inject({
      method,
      url: path + query,
      remoteAddress,
      headers: {
        [INTERNAL_HEADER]: key,
        'user-agent': userAgent,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    const parsed = parseBody(res.body, res.headers['content-type']?.toString());
    if (res.statusCode < 400) return { ok: true, status: res.statusCode, body: parsed as T };
    const problem = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<
      string,
      unknown
    >;
    return {
      ok: false,
      status: res.statusCode,
      code: typeof problem.code === 'string' ? problem.code : `HTTP_${res.statusCode}`,
      title: typeof problem.title === 'string' ? problem.title : 'The request failed',
      detail: problem.detail ?? problem.errors ?? null,
    };
  };
  return {
    get: (path, query) => send('GET', path, queryString(query)),
    post: (path, body) => send('POST', path, '', body),
  };
}

/** The body, or a ToolError carrying the REST problem's code and title. */
export function unwrap<T>(result: CallResult<T>): T {
  if (result.ok) return result.body;
  throw new ToolError(result.title, result.code);
}
