import { gzipSync } from 'node:zlib';
import {
  encodeSnapshotLine,
  REVIEW_SNAPSHOT_CONTENT_TYPE,
  type SnapshotLine,
} from '@qualor/shared';
import { and, eq, inArray, or } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer } from '../../test/app';
import { createFakeGitLab, type FakeGitLab } from '../../test/fake-gitlab';
import { createFakeLlm, type FakeLlm } from '../../test/fake-llm';
import { createIngestHarness, type IngestHarness, type IngestProject } from '../../test/ingest';
import { file } from '../../test/reports';
import {
  reviewResponder,
  reviewRoleOf,
  switchReviewOn,
  type ReviewScript,
} from '../../test/review';
import {
  decorationDeps,
  mappedProject,
  mergeRequestReport,
  PUBLIC_URL,
  queuedDecorations,
  runDecorations,
  silentLogger,
} from '../../test/scm';
import { first } from '../db/rows';
import { analyses, issues, reviewRuns, reviewSnapshots, rules } from '../db/schema';
import { createLlmRuntime } from '../llm/job';
import { runUntilIdle } from '../queue/worker';
import { markerOf } from '../scm/markdown';
import { enqueueDecoration } from '../scm/queue';
import { parseInternalHosts } from '../scm/url';
import { reviewHandlers } from './job';
import { reviewSnapshotHandlers } from './jobs';

/*
 * The first end-to-end test of the AI review (6I-3): a merge request's pipeline sends its report
 * and its repository snapshot through the routes the CLI calls, and the server's own workers do the
 * rest: the analysis worker ingests the report and unpacks the snapshot, the review worker reviews
 * the merge request with a scripted provider, and the scm worker decorates it on the fake GitLab.
 * Then a second push, and a merge.
 */

const GITLAB_PROJECT = 820;
const IID = 3;
const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const BASE = 'b'.repeat(40);
const PATH = 'src/cart.ts';

/** The file the merge request adds, at its first head ... */
const AT_H1 = [
  'export function total(items: number[]): number {',
  '  let sum = 0;',
  '  for (let i = 0; i < items.length - 1; i += 1) {',
  '    sum += items[i];',
  '  }',
  '  return sum;',
  '}',
  'export const discount = (price: number, rate: number): number =>',
  '  price - price * rate * 100;',
];
/** ... and at its second, where the discount is fixed (line 9) and the loop is not. */
const AT_H2 = [...AT_H1.slice(0, 8), '  price - price * rate;'];

/** GitLab's diff, and the snapshot's patch, of a file the merge request adds. */
const added = (lines: readonly string[]) =>
  `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`;

/**
 * The snapshot the scanner sends for `head`: the one file it adds, with the lines changed since the
 * last reviewed commit (`since`) on a re-review.
 */
function snapshotOf(o: {
  head: string;
  since: string | null;
  lines: readonly string[];
  ranges: [number, number][] | null;
}): Buffer {
  const lines: SnapshotLine[] = [
    {
      type: 'header',
      v: 1,
      headSha: o.head,
      baseSha: BASE,
      sinceSha: o.since,
      targetBranch: 'main',
      mergeRequest: { id: String(IID), title: 'Add the cart', description: null },
      partial: false,
      generator: 'qualor-cli/test',
    },
    {
      type: 'change',
      path: PATH,
      oldPath: null,
      status: 'added',
      patch: added(o.lines),
      since: o.ranges,
    },
    { type: 'file', path: PATH, text: `${o.lines.join('\n')}\n` },
    { type: 'end', files: 1, changes: 1, omitted: 0 },
  ];
  return gzipSync(lines.map(encodeSnapshotLine).join(''));
}

const LOOP = {
  category: 'logic',
  severity: 'major',
  confidence: 'high',
  path: PATH,
  line: 3,
  endLine: 3,
  title: 'The loop skips the last item',
  body: 'The loop stops one item early, so the last item is never added to the sum.',
  suggestion: {
    startLine: 3,
    endLine: 4,
    lines: ['  for (let i = 0; i < items.length; i += 1) {', '    sum += items[i];'],
  },
};
const DISCOUNT = {
  category: 'logic',
  severity: 'critical',
  confidence: 'high',
  path: PATH,
  line: 9,
  endLine: 9,
  title: 'The discount is a hundred times too large',
  body: 'The rate is multiplied by a hundred, so a discount of ten per cent takes the whole price off.',
};
/** The first review: the quality reviewer finds both, and the judge keeps both. */
const FIRST: ReviewScript = {
  quality: JSON.stringify({ findings: [LOOP, DISCOUNT] }),
  judge: JSON.stringify({
    findings: [
      { ...DISCOUNT, sources: ['s2'] },
      { ...LOOP, sources: ['s1'] },
    ],
    dropped: [],
    prior: [],
    summary: {
      verdict: 'Two logic problems in the cart.',
      walkthrough: ['Adds a cart total and a discount.'],
    },
  }),
};
/** A problem of the changed line 9 the re-review finds. */
const NEGATIVE = {
  category: 'logic',
  severity: 'major',
  confidence: 'medium',
  path: PATH,
  line: 9,
  endLine: 9,
  title: 'A rate above one makes the price negative',
  body: 'Nothing keeps the rate between zero and one, so a rate above one gives a negative price.',
};
/**
 * The re-review: the judge finds the loop still there and the discount fixed, and keeps the one
 * new finding, which is on a line changed since the reviewed commit.
 */
const second = (loop: string, discount: string): ReviewScript => ({
  quality: JSON.stringify({ findings: [NEGATIVE] }),
  judge: JSON.stringify({
    findings: [{ ...NEGATIVE, sources: ['s1'] }],
    dropped: [],
    prior: [
      { id: loop, status: 'present', reason: 'The loop still stops one item early.' },
      { id: discount, status: 'fixed', reason: 'The rate is no longer multiplied by a hundred.' },
    ],
    summary: {
      verdict: 'The discount is fixed; the loop still skips the last item.',
      walkthrough: [],
    },
  }),
});

describe('the AI review of a GitLab merge request (6I-3)', () => {
  let llm: FakeLlm;
  let gitlab: FakeGitLab;
  let h: IngestHarness;
  let p: IngestProject;

  /** The merge request's pipeline at `head`: its report, uploaded and ingested. */
  const pipeline = (head: string, n: number) =>
    p.ingestOk(
      mergeRequestReport(IID, head, {
        projectKey: p.key,
        gitlab: { projectId: String(GITLAB_PROJECT), mergeRequestEventType: 'detached' },
        analysisDate: `2026-10-0${n}T10:00:00Z`,
        files: [file(PATH, { lines: AT_H1.length, newLines: [[1, AT_H1.length]] })],
        findings: [],
      }),
    );
  /** The scanner's upload of the snapshot, through the route the CLI calls. */
  const upload = (analysisId: string, body: Buffer) =>
    h.ctx.app.inject({
      method: 'POST',
      url: `/api/v0/analyses/${analysisId}/review-snapshot?projectKey=${encodeURIComponent(p.key)}`,
      headers: {
        ...bearer(p.token),
        'content-type': REVIEW_SNAPSHOT_CONTENT_TYPE,
        'content-encoding': 'gzip',
      },
      payload: body,
    });
  /** The analysis worker's unpack jobs. */
  const unpack = () =>
    runUntilIdle(
      h.ctx.db,
      reviewSnapshotHandlers({
        db: h.ctx.db,
        logger: h.ctx.app.log,
        limits: h.ctx.config.reviewSnapshot,
      }),
      silentLogger,
    );
  /** The review worker, with the scripted answers the fake provider was given. */
  const review = (...scripts: ReviewScript[]) => {
    llm.enqueue(...scripts.map((script) => reviewResponder(script)));
    return runUntilIdle(
      h.ctx.db,
      reviewHandlers({
        db: h.ctx.db,
        config: h.ctx.config,
        logger: silentLogger,
        llmCircuit: createLlmRuntime().circuit,
        scm: decorationDeps(h).scm,
      }),
      silentLogger,
    );
  };
  const runOf = async (analysisId: string) =>
    first(await h.ctx.db.select().from(reviewRuns).where(eq(reviewRuns.analysisId, analysisId)));
  const aiIssueId = async (title: string) =>
    first(
      await h.ctx.db
        .select({ id: issues.id })
        .from(issues)
        .innerJoin(rules, eq(rules.id, issues.ruleId))
        .where(
          and(eq(issues.projectId, p.id), eq(rules.engineId, 'ai'), eq(issues.message, title)),
        ),
    ).id;
  /** Qualor's threads on the merge request, by the issue their marker names. */
  const threads = () =>
    new Map(
      gitlab.discussions(GITLAB_PROJECT, IID).flatMap((d) => {
        const marker = d.notes[0] === undefined ? null : markerOf(d.notes[0].body);
        return marker?.kind === 'issue' ? [[marker.issueId, d] as const] : [];
      }),
    );
  const summary = () =>
    gitlab
      .discussions(GITLAB_PROJECT, IID)
      .flatMap((d) => d.notes)
      .find((n) => markerOf(n.body)?.kind === 'summary')?.body ?? '';
  const snapshotsOfBranch = (branchId: string) =>
    h.ctx.db
      .select({ id: reviewSnapshots.id })
      .from(reviewSnapshots)
      .where(
        or(
          eq(reviewSnapshots.branchId, branchId),
          inArray(
            reviewSnapshots.analysisId,
            h.ctx.db
              .select({ id: analyses.id })
              .from(analyses)
              .where(eq(analyses.branchId, branchId)),
          ),
        ),
      );

  beforeAll(async () => {
    llm = await createFakeLlm();
    gitlab = await createFakeGitLab();
    h = await createIngestHarness({
      config: {
        publicUrl: PUBLIC_URL,
        scmInternalHosts: parseInternalHosts(new URL(gitlab.url).host),
        llmInternalHosts: parseInternalHosts(llm.host),
      },
    });
    gitlab.addProject({ id: GITLAB_PROJECT, path: 'acme/cart' });
    p = await mappedProject(h, gitlab, 'flow/cart', GITLAB_PROJECT);
    await switchReviewOn(h.ctx.db, {
      secretKey: h.ctx.config.secretKey,
      fake: llm,
      organizationId: h.organizationId,
      userId: h.ctx.adminId,
    });
  });
  afterAll(async () => {
    await h.close();
    await gitlab.close();
    await llm.close();
  });

  it('a merge request reviewed end to end', async () => {
    gitlab.addMergeRequest(GITLAB_PROJECT, {
      iid: IID,
      title: 'Add the cart',
      state: 'opened',
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      headSha: H1,
      baseSha: BASE,
      startSha: BASE,
      diffs: [{ oldPath: PATH, newPath: PATH, diff: added(AT_H1), newFile: true }],
    });

    // The pipeline of the first head: the report is ingested and the review run waits for the
    // snapshot. The analyzers' decoration does not wait for it: the summary says the review is in
    // progress, and there is no AI thread yet.
    const a1 = await pipeline(H1, 1);
    expect(await runOf(a1)).toMatchObject({ status: 'waiting' });
    await runDecorations(h, decorationDeps(h));
    expect(summary()).toContain('#### AI review\n\nAI review in progress…');
    expect(threads().size).toBe(0);
    // The scanner uploads the snapshot and the analysis worker unpacks it, which wakes the run.
    const sent = await upload(
      a1,
      snapshotOf({ head: H1, since: null, lines: AT_H1, ranges: null }),
    );
    expect(sent.statusCode).toBe(202);
    expect(await unpack()).toBe(1);
    expect(await queuedDecorations(h)).toEqual([]);
    const calls = llm.requests.length;
    expect(await review(FIRST, FIRST)).toBe(1);
    expect(llm.requests.slice(calls).map(reviewRoleOf)).toEqual(['quality', 'judge']);
    expect(await runOf(a1)).toMatchObject({
      status: 'done',
      headSha: H1,
      sinceSha: null,
      tier: 'trivial',
      findingsNew: 2,
      findingsOpen: 2,
    });
    const loop = await aiIssueId(LOOP.title);
    const discount = await aiIssueId(DISCOUNT.title);

    // The review's end queues the decoration of its analysis. The scm worker runs it: the summary
    // has the review's section, and each finding a thread on its line at the head the review read,
    // the loop's with its one-click suggestion.
    expect(await queuedDecorations(h)).toMatchObject([{ payload: { analysisId: a1 } }]);
    await runDecorations(h, decorationDeps(h));
    expect(summary()).toContain(
      [
        '#### AI review',
        '',
        'Two logic problems in the cart.',
        '',
        '**Findings:** 1 high · 1 medium · 0 low',
        '',
        '- Adds a cart total and a discount.',
        '',
        'Reviewed commit: ` 111111111111 `',
      ].join('\n'),
    );
    const first1 = threads();
    expect(first1.size).toBe(2);
    const loopNote = first1.get(loop)?.notes[0];
    expect(loopNote?.position).toMatchObject({
      head_sha: H1,
      base_sha: BASE,
      new_path: PATH,
      new_line: 3,
    });
    expect(loopNote?.body).toContain(
      [
        '```suggestion:-0+1',
        '  for (let i = 0; i < items.length; i += 1) {',
        '    sum += items[i];',
        '```',
      ].join('\n'),
    );
    const discountThread = first1.get(discount);
    expect(discountThread?.notes[0]?.position).toMatchObject({ head_sha: H1, new_line: 9 });
    expect(discountThread?.notes[0]?.body).toContain('**AI review** · High · Logic · likely');
    expect(discountThread?.notes[0]?.body).not.toContain('```suggestion');

    // A second push fixes the discount. The analyzers' decoration of its pipeline says the review
    // is in progress again, and changes no AI thread: the merge request is at a head no finished
    // review read.
    gitlab.updateMergeRequest(GITLAB_PROJECT, IID, {
      headSha: H2,
      diffs: [{ oldPath: PATH, newPath: PATH, diff: added(AT_H2), newFile: true }],
    });
    const a2 = await pipeline(H2, 2);
    expect(await runOf(a2)).toMatchObject({ status: 'waiting' });
    const discussions = `/projects/${GITLAB_PROJECT}/merge_requests/${IID}/discussions`;
    const threadWrites = () =>
      gitlab.requests
        .filter((r) => r.method !== 'GET' && r.path.startsWith(discussions))
        .map((r) => `${r.method} ${r.path}`);
    gitlab.clearRequests();
    await runDecorations(h, decorationDeps(h));
    expect(summary()).toContain('#### AI review\n\nAI review in progress…');
    expect(threadWrites()).toEqual([]);
    expect(threads().size).toBe(2);
    // Its snapshot says which lines changed since the reviewed commit: line 9 only, which misses
    // the loop's lines.
    const resent = await upload(
      a2,
      snapshotOf({ head: H2, since: H1, lines: AT_H2, ranges: [[9, 9]] }),
    );
    expect(resent.statusCode).toBe(202);
    expect(await unpack()).toBe(1);
    expect(await queuedDecorations(h)).toEqual([]);
    expect(await review(second(loop, discount), second(loop, discount))).toBe(1);
    expect(await runOf(a2)).toMatchObject({
      status: 'done',
      headSha: H2,
      sinceSha: H1,
      findingsNew: 1,
      findingsOpen: 2,
      findingsFixed: 1,
    });
    const negative = await aiIssueId(NEGATIVE.title);
    // The review's end queues the decoration that changes the threads.
    expect(await queuedDecorations(h)).toMatchObject([{ payload: { analysisId: a2 } }]);
    gitlab.clearRequests();
    await runDecorations(h, decorationDeps(h));
    // The judge said the discount is fixed: its thread is resolved, by Qualor. The loop's is
    // untouched: not resolved, not written to, not posted again. The new finding gets its thread,
    // on the line of the new head.
    expect(threadWrites()).toEqual([
      `PUT ${discussions}/${discountThread?.id}`,
      `POST ${discussions}`,
    ]);
    const second1 = threads();
    expect(second1.size).toBe(3);
    expect(second1.get(discount)?.notes[0]).toMatchObject({
      resolved: true,
      resolvedBy: gitlab.botUserId,
    });
    expect(second1.get(loop)?.notes).toHaveLength(1);
    expect(second1.get(loop)?.notes[0]).toMatchObject({ resolved: false, body: loopNote?.body });
    expect(second1.get(negative)?.notes[0]?.position).toMatchObject({ head_sha: H2, new_line: 9 });
    expect(second1.get(negative)?.notes[0]?.body).toContain(
      '**AI review** · Medium · Logic · possible · ` ai:logic `',
    );
    expect(summary()).toContain(
      [
        '#### AI review',
        '',
        'The discount is fixed; the loop still skips the last item.',
        '',
        '**Findings:** 0 high · 2 medium · 0 low',
      ].join('\n'),
    );

    // The merge request is merged: the next decoration deletes the snapshots of its branch.
    const { branchId } = await runOf(a2);
    expect(await snapshotsOfBranch(branchId)).toHaveLength(1);
    gitlab.updateMergeRequest(GITLAB_PROJECT, IID, { state: 'merged' });
    await enqueueDecoration(h.ctx.db, { analysisId: a2, branchId, gitlab: null });
    await runDecorations(h, decorationDeps(h));
    expect(await snapshotsOfBranch(branchId)).toEqual([]);
  });
});
