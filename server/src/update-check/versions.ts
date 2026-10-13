/** `X.Y.Z` only: the tags Docker Hub carries for a release (update check, spec U5). */
export function parseStable(tag: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** `X.Y.Z` with an optional `-pre` and `+build`; null for anything else. */
function parseAny(version: string): { core: [number, number, number]; pre: boolean } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+.*)?$/.exec(version);
  return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] !== undefined } : null;
}

/**
 * Semver order without pre-release precedence details: `0.8.0-rc.1` < `0.8.0`, and a dev build
 * such as `0.9.0-dev` is above `0.8.0`. Anything unparsable sorts lowest.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseAny(a);
  const pb = parseAny(b);
  if (pa === null || pb === null) return (pa === null ? 0 : 1) - (pb === null ? 0 : 1);
  const [aMajor, aMinor, aPatch] = pa.core;
  const [bMajor, bMinor, bPatch] = pb.core;
  const diff = aMajor - bMajor || aMinor - bMinor || aPatch - bPatch;
  if (diff !== 0) return diff;
  return (pa.pre ? 0 : 1) - (pb.pre ? 0 : 1);
}

/** The highest stable tag; `latest`, `X.Y`, `staging-…` and pre-releases never count. */
export function latestStable(tags: readonly string[]): string | null {
  let best: string | null = null;
  for (const tag of tags) {
    if (parseStable(tag) === null) continue;
    if (best === null || compareVersions(tag, best) > 0) best = tag;
  }
  return best;
}
