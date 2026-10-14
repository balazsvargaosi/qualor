import { Readable } from 'node:stream';
import type { FastifyRequest } from 'fastify';
import { actorOf, type AuditRecorder } from '../audit/recorder';
import { requireInstanceAdmin } from '../auth/access';
import { ProblemError } from '../http/problem';
import type { LogBuffer } from '../http/log-buffer';
import type { PluginSupport } from '../plugins/contract';
import { collectSupportBundle, type SupportCollectDeps } from './collect';

export const FEATURE = 'support-bundle';

/**
 * 4E-3b §4: the core service behind `ctx.support`. `bundle` answers 403 FEATURE_NOT_LICENSED
 * while the feature is inactive, then requires an instance admin, collects the bundle with this
 * replica's log lines and records `support.bundle_downloaded` before handing it out.
 */
export function createSupportService(deps: {
  /** Read on each bundle: the edition exists only after the plugins loaded (bootEnterprise). */
  collect: () => SupportCollectDeps;
  isFeatureActive: (feature: string) => boolean;
  recorder: AuditRecorder;
  logBuffer?: LogBuffer | undefined;
  /** Tests inject a small cap; the default is SUPPORT_BUNDLE_MAX_BYTES. */
  maxBytes?: number;
}): PluginSupport {
  return Object.freeze({
    bundle: async (request: FastifyRequest) => {
      if (!deps.isFeatureActive(FEATURE)) {
        throw new ProblemError(
          403,
          'FEATURE_NOT_LICENSED',
          `The enterprise feature "${FEATURE}" is not licensed`,
        );
      }
      requireInstanceAdmin(request);
      const collect = deps.collect();
      const bundle = await collectSupportBundle(collect, {
        source: 'ui',
        logs: deps.logBuffer?.snapshot() ?? [],
        ...(deps.maxBytes === undefined ? {} : { maxBytes: deps.maxBytes }),
      });
      await deps.recorder.record(collect.db, actorOf(request), [
        {
          action: 'support.bundle_downloaded',
          details: { source: 'ui', bytes: bundle.data.length },
        },
      ]);
      return { fileName: bundle.fileName, stream: Readable.from(bundle.data) };
    },
  } satisfies PluginSupport);
}
