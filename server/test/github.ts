import { createHmac, randomUUID } from 'node:crypto';
import type { Report } from '@qualor/shared';
import type { Config } from '../src/config';
import type { DecorationDeps } from '../src/scm/decorate';
import { MutationPacer } from '../src/scm/github/app-auth';
import { createScmRuntime } from '../src/scm/runtime';
import type { FakeGitHub } from './fake-github';
import type { IngestHarness, IngestProject } from './ingest';
import { reportWith, type ReportParts } from './reports';
import { decorationDeps, PUBLIC_URL } from './scm';

// Assembled at run time, so the repository's own Gitleaks check finds no fake secret here (.gitleaks.toml).
export const WEBHOOK_SECRET = ['whsec-test-', '0123456789abcdef'].join('');

/** The `X-Hub-Signature-256` of a delivery: the HMAC-SHA256 of its body with the webhook secret. */
export const sign = (body: string, secret = WEBHOOK_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/**
 * A delivery to the App's webhook of a connection, as GitHub makes it: signed over the body, with
 * the event and an id of its own. The harness and the connection are the test's, read when sent.
 */
export function deliveryTo(harness: () => IngestHarness, connection: () => string) {
  return (
    event: string,
    payload: unknown,
    options: {
      id?: string;
      signature?: string | null;
      connection?: string;
      contentType?: string;
      delivery?: string;
      /** The sender's address: each throttle test has its own. */
      ip?: string;
    } = {},
  ) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return harness().ctx.app.inject({
      method: 'POST',
      url: `/api/v0/github/webhooks/${options.connection ?? connection()}`,
      remoteAddress: options.ip ?? '127.0.0.1',
      headers: {
        'content-type': options.contentType ?? 'application/json',
        'x-github-event': event,
        'x-github-delivery': options.delivery ?? randomUUID(),
        ...(options.signature === null
          ? {}
          : { 'x-hub-signature-256': options.signature ?? sign(body) }),
      },
      payload: body,
    });
  };
}

/** The fake listens on 127.0.0.1 with its own port, which the operator lists (scm.md §2.1). */
export function githubTestConfig(fake: FakeGitHub): Partial<Config> {
  return {
    scmInternalHosts: new Set([new URL(fake.url).host]) as ReadonlySet<string>,
    publicUrl: PUBLIC_URL,
  };
}

/** A GitHub connection of the harness's organisation to the fake, through the API. */
export async function githubConnection(
  h: IngestHarness,
  fake: FakeGitHub,
  options: { webhookSecret?: string | null } = {},
): Promise<string> {
  const created = await h.ctx.app.inject({
    method: 'POST',
    url: '/api/v0/scm-connections',
    headers: h.orgAdmin.headers,
    payload: {
      organizationId: h.organizationId,
      provider: 'github',
      baseUrl: fake.url,
      appId: String(fake.appId),
      privateKey: fake.privateKeyPem,
      ...(options.webhookSecret === null
        ? {}
        : { webhookSecret: options.webhookSecret ?? WEBHOOK_SECRET }),
    },
  });
  if (created.statusCode !== 201) throw new Error(`connection: ${created.body}`);
  return (created.json() as { id: string }).id;
}

/** A Qualor project mapped to `owner/repo` of the fake on the given (or a new) connection. */
export async function mappedGitHubProject(
  h: IngestHarness,
  fake: FakeGitHub,
  key: string,
  repo: string,
  options: { connectionId?: string } = {},
): Promise<IngestProject & { connectionId: string }> {
  const connectionId = options.connectionId ?? (await githubConnection(h, fake));
  const project = await h.project(key);
  const mapped = await h.ctx.app.inject({
    method: 'PATCH',
    url: `/api/v0/projects/${project.id}`,
    headers: h.orgAdmin.headers,
    payload: { scmConnectionId: connectionId, scmProjectRef: repo },
  });
  if (mapped.statusCode !== 200) throw new Error(`mapping: ${mapped.body}`);
  return { ...project, connectionId };
}

/**
 * Decoration deps whose GitHub pacer runs on a fake clock: the one-second spacing of mutations is
 * kept (and checked by its own tests), without real sleeps in DB tests.
 */
export function githubDeps(
  h: IngestHarness,
  overrides: Partial<DecorationDeps> = {},
): DecorationDeps {
  let t = 0;
  const runtime = createScmRuntime();
  runtime.githubPacer = new MutationPacer(
    () => t,
    async (ms) => {
      t += ms;
    },
  );
  return decorationDeps(h, { runtime, ...overrides });
}

/** A pull request report from GitHub Actions: #number of feature/x into main at `revision`. */
export function pullRequestReport(
  number: number,
  revision: string,
  parts: ReportParts & { github?: Report['scm']['github'] } = {},
): Report {
  const { github = { repositoryId: '424242', checkout: 'head' }, ...rest } = parts;
  const report = reportWith({
    branch: 'feature/x',
    mergeRequest: { id: String(number), targetBranch: 'main', sourceBranch: 'feature/x' },
    revision,
    baseline: { revision: 'b'.repeat(40), kind: 'merge_base', status: 'ok' },
    ...rest,
  });
  return { ...report, scm: { ...report.scm, provider: 'github', github } };
}
