import { z } from 'zod';
import { issueLine, truncate, type IssueListItem } from '../format';
import { unwrap } from '../inject';
import type { McpTool } from '../tool';

const input = z.object({ issueId: z.uuid().describe('From qualor_issues') });

/** The part of `GET /issues/{id}` this tool reads (`issueDetailSchema`). */
interface IssueDetail extends IssueListItem {
  endLine: number | null;
  /** The report's `{ startLine, lines }` (report-format.md), or null. */
  snippet: unknown;
  secondaryLocations: { path: string; startLine: number; message?: string | null }[];
  rule: IssueListItem['rule'] & {
    descriptionMd: string | null;
    helpUri: string | null;
    cwe: number[];
  };
}

/** One row of `GET /issues/{id}/changelog`. */
interface Change {
  createdAt: string;
  user: { username: string } | null;
  field: 'status' | 'severity' | 'comment';
  oldValue: string | null;
  newValue: string | null;
  comment: string | null;
}

const HISTORY_LIMIT = 20;

/** The snippet as numbered lines, the issue's own lines marked with `>`; null when it has none. */
function snippetText(snippet: unknown, from: number | null, to: number | null): string | null {
  const s = snippet as { startLine?: unknown; lines?: unknown } | null;
  if (!s || typeof s.startLine !== 'number' || !Array.isArray(s.lines)) return null;
  const first = s.startLine;
  const width = String(first + s.lines.length).length;
  return (s.lines as unknown[])
    .map((text, i) => {
      const n = first + i;
      const mark = from !== null && n >= from && n <= (to ?? from) ? '>' : ' ';
      return `${mark} ${String(n).padStart(width)} | ${String(text)}`;
    })
    .join('\n');
}

function changeLine(c: Change): string {
  const who = c.user?.username ?? 'Qualor';
  const what =
    c.field === 'comment'
      ? 'commented'
      : `${c.field} ${c.oldValue ?? '(none)'} → ${c.newValue ?? '(none)'}`;
  return `- ${c.createdAt} ${who}: ${what}${c.comment ? `: ${c.comment}` : ''}`;
}

/** Spec §5: one issue in full. */
export const issueTool: McpTool<typeof input> = {
  name: 'qualor_issue',
  title: 'Issue details',
  description:
    'One issue in full: the code snippet, secondary locations, the rule’s description and CWE, and its history.',
  access: 'read',
  inputSchema: input,
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run({ issueId }, { call }) {
    const issue = unwrap(await call.get<IssueDetail>(`/api/v0/issues/${issueId}`));
    const changes = unwrap(
      await call.get<{ items: Change[]; nextCursor: string | null }>(
        `/api/v0/issues/${issueId}/changelog`,
        { limit: HISTORY_LIMIT },
      ),
    );
    const code = snippetText(issue.snippet, issue.startLine, issue.endLine);
    const parts = [
      issueLine(issue),
      issue.rule.cwe.length ? `CWE: ${issue.rule.cwe.map((c) => `CWE-${c}`).join(', ')}` : '',
      code ? `Code:\n${code}` : '',
      ...issue.secondaryLocations.map(
        (l) => `Related: ${l.path}:${l.startLine}${l.message ? ` ${l.message}` : ''}`,
      ),
      issue.rule.descriptionMd ? `Rule:\n${issue.rule.descriptionMd}` : '',
      issue.rule.helpUri ? `More: ${issue.rule.helpUri}` : '',
      changes.items.length
        ? `History:\n${changes.items.map(changeLine).join('\n')}${changes.nextCursor ? '\n… (older entries only; more exist)' : ''}`
        : '',
    ].filter(Boolean);
    return { text: truncate(parts.join('\n\n')), structured: { issue, history: changes.items } };
  },
};
