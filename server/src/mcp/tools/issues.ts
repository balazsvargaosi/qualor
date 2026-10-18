import { z } from 'zod';
import { issueLine, truncate, type IssueListItem } from '../format';
import { unwrap } from '../inject';
import { branchOf, describeBranch, projectByKey, targetInput } from '../resolve';
import type { McpTool } from '../tool';

const SEVERITIES = ['blocker', 'high', 'medium', 'low', 'info'] as const;
const QUALITIES = ['security', 'reliability', 'maintainability'] as const;

const input = z.object({
  ...targetInput,
  newCodeOnly: z
    .boolean()
    .default(true)
    .describe('Only issues in new code (what the gate counts). Default true.'),
  kind: z
    .enum(['issue', 'hotspot'])
    .default('issue')
    .describe(
      'issue (default): what the quality gate counts. hotspot: security-sensitive code to review, which the gate does not count.',
    ),
  severity: z.array(z.enum(SEVERITIES)).max(5).optional(),
  quality: z.array(z.enum(QUALITIES)).max(3).optional(),
  rule: z.array(z.string().max(512)).max(20).optional().describe('Rule keys, e.g. eslint:no-eval'),
  path: z.array(z.string().max(1024)).max(20).optional().describe('Path prefixes, e.g. src/api/'),
  status: z
    .array(z.enum(['open', 'resolved', 'wont_fix', 'false_positive', 'closed']))
    .max(5)
    .optional()
    .describe('Default: open'),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().max(8192).optional().describe('From the previous answer, for the next page'),
});

interface IssuePage {
  items: IssueListItem[];
  nextCursor: string | null;
}

/** `3 issue(s) on main (new code):`; hotspots say that the gate does not count them. */
function headLine(count: number, target: string, args: { kind: string; newCodeOnly: boolean }) {
  if (args.kind === 'hotspot') {
    const scope = args.newCodeOnly ? 'new code; ' : '';
    return `${count} security hotspot(s) on ${target} (${scope}the gate does not count them):`;
  }
  return `${count} issue(s) on ${target}${args.newCodeOnly ? ' (new code)' : ''}:`;
}

/** Spec §5: the issues of a branch or merge request, most severe first. */
export const issuesTool: McpTool<typeof input> = {
  name: 'qualor_issues',
  title: 'List issues',
  description:
    'Issues of a branch or merge request, most severe first; by default only open issues in new code, which is what the quality gate counts. ' +
    'Security hotspots (code to review, not counted by the gate) are listed only with kind hotspot. ' +
    'Each line has path:line, severity, quality, rule and the issue id for qualor_issue.',
  access: 'read',
  inputSchema: input,
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(args, { call }) {
    const project = await projectByKey(call, args.project);
    const branch = await branchOf(call, project, args);
    const page = unwrap(
      await call.get<IssuePage>('/api/v0/issues', {
        branchId: branch.id,
        limit: args.limit,
        cursor: args.cursor,
        inNewCode: args.newCodeOnly ? true : undefined,
        kind: args.kind,
        severity: args.severity,
        quality: args.quality,
        rule: args.rule,
        path: args.path,
        status: args.status,
        sort: 'severity',
      }),
    );
    const head = headLine(page.items.length, describeBranch(branch), args);
    const more = page.nextCursor ? `\nMore: call again with cursor "${page.nextCursor}".` : '';
    return {
      text: truncate([head, ...page.items.map(issueLine)].join('\n') + more),
      structured: {
        branch: { id: branch.id, name: branch.name, kind: branch.kind },
        issues: page.items.map((i) => ({
          id: i.id,
          path: i.path,
          line: i.startLine,
          severity: i.severity,
          quality: i.quality,
          rule: i.rule.key,
          message: i.message,
          inNewCode: i.inNewCode,
          status: i.status,
          kind: i.kind ?? 'issue',
        })),
        nextCursor: page.nextCursor,
      },
    };
  },
};
