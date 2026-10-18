import { describe, expect, it } from 'vitest';
import { formatChat } from './format';
import type { ChatDigestMessage, ChatGateMessage, DigestRow } from './messages';
import { parseChatMessage } from './messages';

const P = '0190a6c2-0000-7000-8000-0000000000a1';
const B = '0190a6c2-0000-7000-8000-0000000000b1';
const A = '0190a6c2-0000-7000-8000-0000000000c1';
const O = '0190a6c2-0000-7000-8000-0000000000d1';
const LINKS = { publicUrl: 'https://qualor.example.com' };
const NO_LINKS = { publicUrl: null };
const Z = '​';

const failed: ChatGateMessage = {
  type: 'gate',
  event: 'gate.failed',
  cause: 'analysis',
  project: { id: P, key: 'acme/payments', name: 'Payments' },
  branch: { id: B, name: 'main' },
  analysisId: A,
  revision: '3f9c2e1aa0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5',
  at: '2026-10-19T07:05:00.000Z',
  gate: { name: 'Qualor way', status: 'failed' },
  failed: [
    { metric: 'new_issues', operator: 'gt', threshold: 0, value: 2 },
    { metric: 'new_coverage', operator: 'lt', threshold: 80, value: 61.5 },
  ],
  failedCount: 2,
  newIssues: { security: 2, reliability: 0, maintainability: 0 },
};
const recovered: ChatGateMessage = {
  ...failed,
  event: 'gate.recovered',
  gate: { name: 'Qualor way', status: 'passed' },
  failed: [],
  failedCount: 0,
  newIssues: { security: 0, reliability: 0, maintainability: 0 },
};
const sev = (high = 0) => ({ blocker: 0, high, medium: 0, low: 0, info: 0 });
const row = (i: number, over: Partial<DigestRow> = {}): DigestRow => ({
  projectId: `0190a6c2-0000-7000-8000-${String(i).padStart(12, '0')}`,
  name: `Project ${i}`,
  gate: 'passed',
  newSecurity: 1,
  newBySeverity: sev(1),
  openSecurity: 4,
  ...over,
});
const digest: ChatDigestMessage = {
  type: 'digest',
  week: '2026-W43',
  since: '2026-10-12T07:00:00.000Z',
  until: '2026-10-19T07:00:00.000Z',
  timezone: 'Europe/Berlin',
  scope: { organization: { id: O, name: 'Acme' }, project: null },
  totals: { projects: 14, failing: 1, newSecurity: 3, openSecurity: 42, newBySeverity: sev(3) },
  rows: [
    row(1, { name: 'Payments', gate: 'failed', newSecurity: 2, newBySeverity: sev(2) }),
    row(2, { name: 'Billing' }),
  ],
  moreProjects: 0,
  quietProjects: 12,
  top: [
    {
      id: '0190a6c2-0000-7000-8000-0000000000e1',
      projectId: P,
      projectName: 'Payments',
      severity: 'high',
      ruleName: 'SQL injection',
      message: 'SQL built from request data',
      path: 'src/orders.ts',
      line: 42,
    },
  ],
};

describe('Slack gate messages (golden)', () => {
  it('formats a failed gate with links', () => {
    expect(formatChat('slack', failed, LINKS)).toEqual({
      text: 'Quality gate failed — Payments · main',
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'Quality gate failed — Payments · main', emoji: false },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              '*Failing conditions*\n' +
              '• Issues on new code: 2 (fails when greater than 0)\n' +
              '• Coverage on new code: 61.5% (fails when less than 80%)',
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*New code:* Security 2 · Reliability 0 · Maintainability 0',
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'Gate Qualor way · commit `3f9c2e1` · 2026-10-19 07:05 UTC',
            },
          ],
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Open in Qualor' },
              url: `https://qualor.example.com/projects/${P}/branches/${B}`,
              style: 'danger',
            },
          ],
        },
      ],
    });
  });

  it('formats a recovered gate, and says when issues were changed', () => {
    const body = formatChat('slack', { ...recovered, cause: 'reevaluation' }, LINKS) as {
      text: string;
      blocks: { type: string; text?: { text: string } }[];
    };
    expect(body.text).toBe('Quality gate passes again — Payments · main');
    expect(body.blocks[1]!.text!.text).toBe('All conditions pass after issues were changed.');
    expect(JSON.stringify(body)).toContain('"style":"primary"');
  });

  it('has no button and no URL without a public URL (D6)', () => {
    const body = formatChat('slack', failed, NO_LINKS);
    expect(JSON.stringify(body)).not.toContain('"actions"');
    expect(JSON.stringify(body)).not.toContain('https://');
  });

  it('shows at most 5 conditions and says how many more failed', () => {
    const many: ChatGateMessage = {
      ...failed,
      failed: Array.from({ length: 5 }, () => failed.failed[0]!),
      failedCount: 7,
    };
    const text = JSON.stringify(formatChat('slack', many, LINKS));
    expect(text.match(/Issues on new code: 2/g)).toHaveLength(5);
    expect(text).toContain('…and 2 more');
  });

  it('escapes the names a project admin chose (Review Focus 3)', () => {
    const hostile: ChatGateMessage = {
      ...failed,
      project: { ...failed.project, name: '<!channel> *Payments*' },
      gate: { name: '[x](https://evil.example)', status: 'failed' },
    };
    const body = formatChat('slack', hostile, LINKS) as {
      text: string;
      blocks: {
        type: string;
        text?: { type: string; text: string };
        elements?: { text: string }[];
      }[];
    };
    // The top-level text is mrkdwn for Slack's notification: escaped, so nobody is mentioned.
    expect(body.text).toBe(
      `Quality gate failed — &lt;!channel&gt; ${Z}*${Z}Payments${Z}*${Z} · main`,
    );
    // The header is plain_text, which Slack never parses: the raw name, one line.
    expect(body.blocks[0]!.text).toEqual({
      type: 'plain_text',
      text: 'Quality gate failed — <!channel> *Payments* · main',
      emoji: false,
    });
    // Every mrkdwn text is escaped.
    const mrkdwn = body.blocks.flatMap((b) => [
      ...(b.text?.type === 'mrkdwn' ? [b.text.text] : []),
      ...(b.elements ?? []).map((e) => e.text ?? ''),
    ]);
    for (const text of mrkdwn) expect(text).not.toContain('<!channel>');
    // Slack mrkdwn has no `[text](url)` links: the gate name reaches the context as it is.
    expect(mrkdwn.join('\n')).toContain('Gate [x](https://evil.example)');
  });

  it('Teams: a hostile name renders as text, not a link or bold', () => {
    const hostile: ChatGateMessage = {
      ...failed,
      project: { ...failed.project, name: '[click](https://evil.example) **x**' },
    };
    const json = JSON.stringify(formatChat('teams', hostile, LINKS));
    expect(json).not.toContain('[click](');
    expect(json).not.toContain('**x**');
  });
});

describe('Teams gate messages (golden)', () => {
  it('formats a failed gate as an Adaptive Card 1.4 message', () => {
    expect(formatChat('teams', failed, LINKS)).toEqual({
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: null,
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            msteams: { width: 'Full' },
            body: [
              {
                type: 'TextBlock',
                text: 'Quality gate failed — Payments · main',
                weight: 'Bolder',
                size: 'Medium',
                color: 'Attention',
                wrap: true,
              },
              {
                type: 'TextBlock',
                text: 'Failing conditions',
                weight: 'Bolder',
                spacing: 'Medium',
                wrap: true,
              },
              {
                type: 'TextBlock',
                text:
                  '- Issues on new code: 2 (fails when greater than 0)\n' +
                  '- Coverage on new code: 61.5% (fails when less than 80%)',
                wrap: true,
              },
              {
                type: 'FactSet',
                facts: [
                  { title: 'New code', value: 'Security 2 · Reliability 0 · Maintainability 0' },
                  { title: 'Gate', value: 'Qualor way' },
                  { title: 'Commit', value: '3f9c2e1' },
                  { title: 'Time', value: '2026-10-19 07:05 UTC' },
                ],
              },
            ],
            actions: [
              {
                type: 'Action.OpenUrl',
                title: 'Open in Qualor',
                url: `https://qualor.example.com/projects/${P}/branches/${B}`,
              },
            ],
          },
        },
      ],
    });
  });

  it('has no actions without a public URL, and colours a recovery Good', () => {
    const card = (
      formatChat('teams', recovered, NO_LINKS) as {
        attachments: { content: { actions?: unknown; body: { color?: string }[] } }[];
      }
    ).attachments[0]!.content;
    expect(card.actions).toBeUndefined();
    expect(card.body[0]!.color).toBe('Good');
  });
});

describe('digests', () => {
  it('Slack: totals, project rows with links, the folded line and the top issue', () => {
    const json = JSON.stringify(formatChat('slack', digest, LINKS));
    expect(json).toContain('Weekly security digest — Acme');
    expect(json).toContain(
      '*3* new security issues · *1* failing quality gate · *42* open security issues',
    );
    expect(json).toContain(
      `<https://qualor.example.com/projects/${row(1).projectId}|Payments> — gate failed · 2 new (High 2) · 4 open`,
    );
    expect(json).toContain('12 more projects: no new security issues, gate passed');
    expect(json).toContain(
      `High · Payments · <https://qualor.example.com/projects/${P}/issues/0190a6c2-0000-7000-8000-0000000000e1|SQL injection> — \`src/orders.ts:42\``,
    );
    expect(json).toContain('2026-10-12 – 2026-10-19 (Europe/Berlin)');
  });

  it('Slack: 20 rows, then the rest as a count; every text within 3000 characters', () => {
    const big: ChatDigestMessage = {
      ...digest,
      rows: Array.from({ length: 20 }, (_, i) => row(i + 1, { name: 'N'.repeat(500) })),
      moreProjects: 7,
    };
    const body = formatChat('slack', big, LINKS) as { blocks: { text?: { text: string } }[] };
    expect(body.blocks.length).toBeLessThanOrEqual(50);
    for (const b of body.blocks) expect([...(b.text?.text ?? '')].length).toBeLessThanOrEqual(3000);
    // Rows that do not fit in 3000 characters are counted into the "more" line, not cut off.
    const more = /…and (\d+) more projects/.exec(JSON.stringify(body));
    expect(Number(more?.[1])).toBeGreaterThanOrEqual(7);
  });

  it('Teams: the same digest within 28 KB', () => {
    const big: ChatDigestMessage = {
      ...digest,
      rows: Array.from({ length: 20 }, (_, i) => row(i + 1, { name: 'Ü'.repeat(500) })),
      top: Array.from({ length: 3 }, () => ({
        ...digest.top[0]!,
        message: 'm'.repeat(4000),
        path: 'p'.repeat(4000),
      })),
      moreProjects: 7,
    };
    const json = JSON.stringify(formatChat('teams', big, LINKS));
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(28_000);
    expect(json).toContain('…and 7 more projects');
  });

  it('a project digest names the project, and no row links without a public URL', () => {
    const one: ChatDigestMessage = {
      ...digest,
      scope: { ...digest.scope, project: { id: P, name: 'Payments' } },
    };
    const json = JSON.stringify(formatChat('slack', one, NO_LINKS));
    expect(json).toContain('Weekly security digest — Payments');
    expect(json).not.toContain('https://');
  });
});

describe('test messages', () => {
  it.each(['slack', 'teams'] as const)('%s: says it works and names the scope', (kind) => {
    const json = JSON.stringify(
      formatChat(
        kind,
        { type: 'test', organization: { id: O, name: 'Acme' }, project: null },
        LINKS,
      ),
    );
    expect(json).toContain('Qualor is connected');
    expect(json).toContain('every project of Acme');
  });
});

describe('parseChatMessage (R5)', () => {
  it('accepts a stored message of its own event and nothing else', () => {
    expect(parseChatMessage('gate.failed', failed)).toEqual(failed);
    expect(parseChatMessage('gate.recovered', failed)).toBeNull();
    expect(parseChatMessage('digest.weekly', failed)).toBeNull();
    expect(parseChatMessage('digest.weekly', digest)).toEqual(digest);
    expect(parseChatMessage('gate.failed', { type: 'gate' })).toBeNull();
    expect(parseChatMessage('gate.failed', null)).toBeNull();
  });
});
