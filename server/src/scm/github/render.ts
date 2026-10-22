import { createHash } from 'node:crypto';
import type { GateResult } from '@qualor/shared';
import { linesWithinBytes, plainValue, reviewMarker } from '../markdown';
import { commitStatusFor, SUMMARY_MAX_BYTES } from '../render';

/** GitHub's bound on a check run's `output.title`. */
const TITLE_MAX = 255;

/**
 * {@link plainValue} bounded to `max` UTF-16 code units as well as code points: GitHub counts a
 * title's length in characters, and a value outside the BMP takes two units each.
 */
function plainWithin(value: string, max: number): string {
  let bound = max;
  let text = plainValue(value, bound);
  while (text.length > max && bound > 1) {
    // A code point is one or two units: dropping half the excess never drops more than needed.
    bound -= Math.ceil((text.length - max) / 2);
    text = plainValue(value, bound);
  }
  return text;
}

/**
 * github.md §6.1 (ruling T4): the digest of every check run's external id. A check run carries no
 * annotation any more (findings are review threads, §6.4), so the digest is always that of an empty
 * annotation list as 0.11 computed it: the first 16 hex characters of the SHA-256 of `[]`. A check
 * run 0.11 made with annotations has another digest, so the next decoration replaces it once with
 * one without (GitHub cannot take an annotation off a check run); one 0.11 made without any has
 * this digest and is kept. Changing this value replaces the check run of every revision once.
 */
export const NO_ANNOTATIONS_DIGEST = createHash('sha256')
  .update('[]', 'utf8')
  .digest('hex')
  .slice(0, 16);

const EXTERNAL_ID =
  /^qualor:v1:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{16})$/;

/** github.md §6.1: `qualor:v1:<analysisId>:<digest>`; throws on anything it could not read back. */
export function checkRunExternalId(analysisId: string, digest: string): string {
  const id = `qualor:v1:${analysisId}:${digest}`;
  if (!EXTERNAL_ID.test(id)) throw new Error('not a Qualor check run id');
  return id;
}

/** The analysis and digest of a Qualor check run's `external_id`, or null for any other. */
export function parseCheckRunExternalId(
  value: string | null,
): { analysisId: string; digest: string } | null {
  const match = value === null ? null : EXTERNAL_ID.exec(value);
  return match?.[1] && match[2] ? { analysisId: match[1], digest: match[2] } : null;
}

/** github.md §6.1: the conclusion and title, from scm.md §5.1's table (catalog text only). */
export function checkRunVerdict(gate: GateResult): {
  conclusion: 'success' | 'failure';
  title: string;
} {
  const { state, description } = commitStatusFor(gate);
  return {
    conclusion: state === 'success' ? 'success' : 'failure',
    title: plainWithin(description, TITLE_MAX),
  };
}

/**
 * github.md §6.1: the summary comment's body without its marker line, at most 16 KiB (cut at
 * whole lines, so no code span is left open), far below GitHub's 65 535 characters.
 */
export function checkRunSummary(body: string): string {
  const lines = body.split('\n');
  return linesWithinBytes(
    lines[0]?.startsWith('<!-- qualor:') ? lines.slice(1) : lines,
    SUMMARY_MAX_BYTES,
  );
}

/**
 * github.md §6.4: the body of the pull request review that carries a decoration's `count` new
 * threads, so GitHub notifies once and shows one timeline entry for them: a marker line, then
 * fixed text and a number. GitHub requires a body with `event: COMMENT`.
 */
export function reviewBody(projectId: string, count: number): string {
  const issues = count === 1 ? '1 new issue' : `${count} new issues`;
  return `${reviewMarker(projectId)}\nQualor: ${issues} on changed lines.`;
}
