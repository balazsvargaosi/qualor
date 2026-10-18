import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, organizationId, type TestContext } from '../../../test/app';
import { encryptionKey, encryptSecret } from '../../crypto/secrets';
import { first } from '../../db/rows';
import { instanceSettings, webhookDeliveries, webhookSubscriptions } from '../../db/schema';
import { parseInternalHosts } from '../../scm/url';
import { runUntilIdle } from '../../queue/worker';
import { webhookHandlers, type DeliveryDeps } from '../deliver';
import { createDelivery, WEBHOOK_URL_AAD } from '../deliveries';
import type { ChatGateMessage } from './messages';

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const P = '0190a6c2-0000-7000-8000-0000000000a1';
const B = '0190a6c2-0000-7000-8000-0000000000b1';
const A = '0190a6c2-0000-7000-8000-0000000000c1';
const GATE: ChatGateMessage = {
  type: 'gate',
  event: 'gate.failed',
  cause: 'analysis',
  project: { id: P, key: 'acme/payments', name: 'Payments' },
  branch: { id: B, name: 'main' },
  analysisId: A,
  revision: null,
  at: '2026-10-19T07:05:00.000Z',
  gate: { name: 'Qualor way', status: 'failed' },
  failed: [{ metric: 'new_issues', operator: 'gt', threshold: 0, value: 1 }],
  failedCount: 1,
  newIssues: { security: 1, reliability: 0, maintainability: 0 },
};

/** A port nothing listens on: bind one, read its number, close it again. */
function freePort(): Promise<number> {
  return new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

describe('chat webhook delivery (6G spec §4)', () => {
  let t: TestContext;
  let org: string;
  let server: Server;
  let port: number;
  let received: { headers: IncomingMessage['headers']; body: string; path: string }[];
  let respond: (res: ServerResponse) => void;
  let deps: DeliveryDeps;
  const logs: string[] = [];

  const chatHook = async (kind: 'slack' | 'teams', overrides: Record<string, unknown> = {}) => {
    const url = `http://127.0.0.1:${port}/services/T0001/B0001/SECRETpart${kind}`;
    return first(
      await t.db
        .insert(webhookSubscriptions)
        .values({
          organizationId: org,
          kind,
          url: 'https://hooks.slack.com/services/T…/…/xxxx',
          urlEnc: encryptSecret(encryptionKey(t.config.secretKey), url, WEBHOOK_URL_AAD),
          secretEnc: null,
          events: ['gate.failed'],
          ...overrides,
        })
        .returning({ id: webhookSubscriptions.id }),
    ).id;
  };
  const deliver = async (
    subscriptionId: string,
    payload: unknown = GATE,
    event = 'gate.failed' as const,
  ) => {
    const id = await t.db.transaction((tx) =>
      createDelivery(tx, { subscriptionId, event, payload }),
    );
    await runUntilIdle(t.db, webhookHandlers(deps), silent);
    return first(await t.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)));
  };

  beforeAll(async () => {
    t = await createTestContext();
    org = await organizationId(t, 'default');
    await t.db
      .insert(instanceSettings)
      .values({ key: 'webhooks', value: { allowHttp: true, allowInternalHosts: true } });
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
          path: req.url ?? '',
        });
        respond(res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    deps = {
      db: t.db,
      secretKey: t.config.secretKey,
      timeoutMs: 1_000,
      publicUrl: 'https://qualor.example.com',
      chatTestHosts: parseInternalHosts(`127.0.0.1:${port}`),
      logger: {
        info: (o: unknown, m?: string) => void logs.push(JSON.stringify(o) + (m ?? '')),
        warn: (o: unknown, m?: string) => void logs.push(JSON.stringify(o) + (m ?? '')),
      } as unknown as DeliveryDeps['logger'],
    };
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await t.close();
  });
  beforeEach(() => {
    received = [];
    respond = (res) => res.writeHead(200).end('ok');
  });

  it('posts the Slack body to the decrypted URL without signature headers', async () => {
    const row = await deliver(await chatHook('slack'));
    expect(row.status).toBe('succeeded');
    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request!.path).toBe('/services/T0001/B0001/SECRETpartslack');
    expect(request!.headers['content-type']).toBe('application/json');
    expect(request!.headers['user-agent']).toMatch(/^Qualor-Webhook\//);
    for (const h of [
      'x-qualor-event',
      'x-qualor-delivery',
      'x-qualor-timestamp',
      'x-qualor-signature',
    ]) {
      expect(request!.headers).not.toHaveProperty(h);
    }
    const body = JSON.parse(request!.body) as { text: string; blocks: unknown[] };
    expect(body.text).toBe('Quality gate failed — Payments · main');
    expect(JSON.stringify(body)).toContain(
      `https://qualor.example.com/projects/${P}/branches/${B}`,
    );
  });

  it('posts the Teams Adaptive Card message', async () => {
    await deliver(await chatHook('teams'));
    const body = JSON.parse(received[0]!.body) as {
      type: string;
      attachments: { contentType: string }[];
    };
    expect(body.type).toBe('message');
    expect(body.attachments[0]!.contentType).toBe('application/vnd.microsoft.card.adaptive');
  });

  it('sends no links without a public URL', async () => {
    const saved = deps;
    deps = { ...deps, publicUrl: null };
    try {
      await deliver(await chatHook('slack'));
    } finally {
      deps = saved;
    }
    expect(received[0]!.body).not.toContain('https://');
  });

  it.each([404, 410])(
    'a %s is final, with the wording of R10, and never logs the URL',
    async (status) => {
      respond = (res) => res.writeHead(status).end('no_service');
      const row = await deliver(await chatHook('slack'));
      expect(row).toMatchObject({
        status: 'failed',
        attempts: 1,
        responseCode: status,
        responseExcerpt: 'The Slack webhook no longer exists; create a new one. Answer: no_service',
        nextAttemptAt: null,
      });
      expect(received).toHaveLength(1);
      expect(logs.join('\n')).not.toContain('SECRETpart');
    },
  );

  it('retries a 500 like any webhook', async () => {
    respond = (res) => res.writeHead(500).end('rollup_error');
    const row = await deliver(await chatHook('slack'));
    expect(row).toMatchObject({ status: 'pending', attempts: 1, responseCode: 500 });
  });

  it('refuses at once, without a request, a URL that no longer decrypts (Review Focus 5)', async () => {
    const id = await chatHook('slack', {
      urlEnc: encryptSecret(
        encryptionKey('another-secret-key-of-32-characters!!'),
        'https://hooks.slack.com/services/T/B/x',
        WEBHOOK_URL_AAD,
      ),
    });
    const row = await deliver(id);
    expect(row).toMatchObject({
      status: 'failed',
      responseCode: null,
      responseExcerpt:
        'The webhook URL cannot be decrypted (QUALOR_SECRET_KEY changed?); enter the URL again',
    });
    expect(received).toHaveLength(0);
  });

  it('refuses a host the kind does not allow, checked again at delivery', async () => {
    const saved = deps;
    deps = { ...deps, chatTestHosts: new Set() };
    try {
      const row = await deliver(await chatHook('slack'));
      expect(row.status).toBe('failed');
      expect(row.responseExcerpt).toMatch(/Slack incoming webhook URL/);
    } finally {
      deps = saved;
    }
    expect(received).toHaveLength(0);
  });

  it('fails a payload that does not parse as its event message (R5)', async () => {
    const row = await deliver(await chatHook('slack'), { type: 'gate', nonsense: true });
    expect(row).toMatchObject({
      status: 'failed',
      responseExcerpt: 'The message could not be formatted',
    });
    expect(received).toHaveLength(0);
  });
  it('never keeps the secret path of the URL in a delivery row (Review Focus 1)', async () => {
    const ids: string[] = [];
    for (const status of [500, 400, 404, 410]) {
      respond = (res) => void res.writeHead(status).end(`error at ${received.at(-1)?.path}`);
      const row = await deliver(await chatHook('slack'));
      ids.push(row.id);
    }
    // A refused connection: the error text of the network failure names the address it tried.
    const dead = await freePort();
    const saved = deps;
    deps = { ...deps, chatTestHosts: parseInternalHosts(`127.0.0.1:${dead}`) };
    try {
      const url = `http://127.0.0.1:${dead}/services/T0001/B0001/SECRETpartdead`;
      const row = await deliver(
        await chatHook('slack', {
          urlEnc: encryptSecret(encryptionKey(t.config.secretKey), url, WEBHOOK_URL_AAD),
        }),
      );
      ids.push(row.id);
    } finally {
      deps = saved;
    }
    const rows = await t.db.select().from(webhookDeliveries);
    const mine = rows.filter((r) => ids.includes(r.id));
    expect(mine).toHaveLength(5);
    for (const r of mine) {
      expect(r.responseExcerpt ?? '').not.toContain('SECRETpart');
      expect(r.responseExcerpt ?? '').not.toContain('T0001');
    }
  });
});
