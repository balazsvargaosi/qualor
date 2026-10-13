import { z } from 'zod';
import { latestStable } from './versions';

const DEFAULT_TIMEOUT_MS = 5_000;
/** 31 tags with their image lists are already 35 KB; a page of 100 stays well below this. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** One page of Docker Hub's tag list; every other field is ignored. */
const tagsPage = z.object({ results: z.array(z.object({ name: z.string() })) });

export type FetchOutcome = { ok: true; latest: string | null } | { ok: false; reason: string };

/** The body as text, or null once it grows past `maxBytes` (the rest is not read). */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * telemetry.md "Update check": one GET of the `qualor/server` tag list, 5 s at most, no redirect,
 * no retry, nothing about the installation in the request. The outcome is returned, never thrown.
 */
export async function fetchLatestVersion(
  url: string,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<FetchOutcome> {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'qualor-server' },
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, reason: `HTTP ${response.status}` };
    }
    if (response.body === null) return { ok: false, reason: 'invalid' };
    const text = await readCapped(response.body, options.maxBytes ?? MAX_RESPONSE_BYTES);
    if (text === null) return { ok: false, reason: 'too large' };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'invalid' };
    }
    const parsed = tagsPage.safeParse(json);
    if (!parsed.success) return { ok: false, reason: 'invalid' };
    return { ok: true, latest: latestStable(parsed.data.results.map((r) => r.name)) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.name : 'error' };
  }
}
