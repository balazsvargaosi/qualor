import { fetchLatestVersion, type FetchOutcome } from './fetch-latest';
import { compareVersions } from './versions';

export const UPDATE_CHECK_FIRST_DELAY_MS = 60_000;
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateSource {
  /** The newest release above this server's version from the last good check, or null. */
  latest(): string | null;
}

export interface UpdateChecker extends UpdateSource {
  start(): void;
  stop(): void;
  checkNow(): Promise<void>;
}

export function releaseNotesUrl(version: string): string {
  return `https://github.com/qualor-dev/qualor/releases/tag/v${version}`;
}

/**
 * telemetry.md "Update check": a minute after start and then daily, in memory on every replica,
 * created only while telemetry is on (main.ts). Never throws; a failed check is a debug line and
 * keeps the last good result; each newer release is logged once at info level.
 */
export function createUpdateChecker(deps: {
  url: string;
  currentVersion: string;
  logger: { info(obj: object, msg: string): void; debug(obj: object, msg: string): void };
  fetchLatest?: (url: string) => Promise<FetchOutcome>;
}): UpdateChecker {
  const fetchLatest = deps.fetchLatest ?? ((url: string) => fetchLatestVersion(url));
  let latest: string | null = null;
  let logged: string | null = null;
  let first: NodeJS.Timeout | undefined;
  let every: NodeJS.Timeout | undefined;

  const checkNow = async (): Promise<void> => {
    let outcome: FetchOutcome;
    try {
      outcome = await fetchLatest(deps.url);
    } catch (err) {
      outcome = { ok: false, reason: err instanceof Error ? err.name : 'error' };
    }
    if (!outcome.ok) {
      deps.logger.debug(
        { component: 'update-check', reason: outcome.reason },
        'update check failed',
      );
      return;
    }
    latest =
      outcome.latest !== null && compareVersions(outcome.latest, deps.currentVersion) > 0
        ? outcome.latest
        : null;
    if (latest !== null && latest !== logged) {
      logged = latest;
      deps.logger.info(
        { component: 'update-check', latest },
        `Qualor ${latest} is available (this server runs ${deps.currentVersion}): ${releaseNotesUrl(latest)}`,
      );
    }
  };

  return {
    latest: () => latest,
    checkNow,
    start() {
      if (first !== undefined || every !== undefined) return;
      first = setTimeout(() => {
        first = undefined;
        void checkNow();
        every = setInterval(() => void checkNow(), UPDATE_CHECK_INTERVAL_MS);
        every.unref();
      }, UPDATE_CHECK_FIRST_DELAY_MS);
      first.unref();
    },
    stop() {
      clearTimeout(first);
      clearInterval(every);
      first = undefined;
      every = undefined;
    },
  };
}

/**
 * telemetry.md "Update check": the checker main.ts starts, or none while telemetry is off, so
 * `QUALOR_TELEMETRY=false` means no request to Docker Hub at all.
 */
export function updateCheckerFor(
  config: { telemetry: { enabled: boolean }; updateCheck: { url: string } },
  deps: Omit<Parameters<typeof createUpdateChecker>[0], 'url'>,
): UpdateChecker | undefined {
  return config.telemetry.enabled
    ? createUpdateChecker({ ...deps, url: config.updateCheck.url })
    : undefined;
}
