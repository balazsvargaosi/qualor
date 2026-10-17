import { z } from 'zod';
import {
  outboundRequest,
  type OutboundOptions,
  type OutboundRequest,
  type OutboundResult,
  type Resolver,
} from '../http/outbound';
import { redirectUriAllowed } from './redirect';

const MAX_BYTES = 64 * 1024;
const MIN_AGE = 300;
const MAX_AGE = 86_400;
const DEFAULT_AGE = 3_600;

/** Shown to the user and linked to: https only, never `javascript:` or `data:`. */
const httpsUrl = z
  .url()
  .max(2048)
  .refine((value) => value.startsWith('https://'), 'must be an https URL')
  .optional();

/** The fields Qualor reads from a Client ID Metadata Document; others are kept but ignored. */
export const cimdDocumentSchema = z.looseObject({
  client_id: z.string().max(2048),
  client_name: z.string().min(1).max(200).optional(),
  client_uri: httpsUrl,
  logo_uri: httpsUrl,
  redirect_uris: z.array(z.string().max(2048)).min(1).max(20),
  token_endpoint_auth_method: z.literal('none').optional(),
  grant_types: z.array(z.string().max(64)).max(10).optional(),
  response_types: z.array(z.string().max(64)).max(10).optional(),
});
export type CimdDocument = z.infer<typeof cimdDocumentSchema>;

export type CimdResult =
  { ok: true; document: CimdDocument; maxAgeSeconds: number } | { ok: false; reason: string };

type Request = (request: OutboundRequest, options: OutboundOptions) => Promise<OutboundResult>;

/** A client id that is a CIMD URL: https, a path beyond `/`, no fragment or user info. */
export function isCimdClientId(clientId: string): boolean {
  if (clientId.length > 2048 || !clientId.startsWith('https://') || clientId.includes('#')) {
    return false;
  }
  try {
    const url = new URL(clientId);
    return (
      url.pathname !== '/' &&
      !url.username &&
      !url.password &&
      !/(?:^|\/)\.{1,2}(?:\/|$)/.test(url.pathname.replace(/%2e/gi, '.')) &&
      !/\/\.{1,2}(?:\/|$)/.test(clientId.slice('https://'.length))
    );
  } catch {
    return false;
  }
}

function maxAge(header: string | string[] | undefined): number {
  const value = Array.isArray(header) ? header.join(',') : (header ?? '');
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(value);
  if (!match) return DEFAULT_AGE;
  return Math.min(MAX_AGE, Math.max(MIN_AGE, Number(match[1])));
}

/** Spec §7: fetch and validate a client's metadata document; never throws. */
export async function fetchCimd(
  url: string,
  options: { resolve?: Resolver; request?: Request } = {},
): Promise<CimdResult> {
  const send = options.request ?? outboundRequest;
  const result = await send(
    { url, method: 'GET', headers: { accept: 'application/json' } },
    {
      allowInternalHosts: false,
      timeoutMs: 5_000,
      maxResponseBytes: MAX_BYTES,
      overflow: 'fail',
      names: { noun: 'client metadata', target: 'the client metadata host' },
      ...(options.resolve ? { resolve: options.resolve } : {}),
    },
  );
  if (result.kind === 'failed') return { ok: false, reason: result.reason };
  if (result.status !== 200) return { ok: false, reason: `HTTP ${result.status}` };
  let json: unknown;
  try {
    json = JSON.parse(result.body.toString('utf8'));
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  const parsed = cimdDocumentSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: 'invalid client metadata' };
  const document = parsed.data;
  if (document.client_id !== url) return { ok: false, reason: 'client_id does not match the URL' };
  if (!document.redirect_uris.every(redirectUriAllowed)) {
    return { ok: false, reason: 'a redirect URI is not allowed' };
  }
  return { ok: true, document, maxAgeSeconds: maxAge(result.headers['cache-control']) };
}
