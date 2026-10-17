import { z } from 'zod';
import { lineRanges, truncate } from '../format';
import { unwrap } from '../inject';
import { branchOf, describeBranch, projectByKey, targetInput } from '../resolve';
import type { McpTool } from '../tool';

const input = z.object({
  ...targetInput,
  file: z.string().min(1).max(1024).optional().describe('A file path: also its line coverage'),
});

type Ranges = [number, number][];

/** `GET /branches/{id}/measures`: one row per metric. */
interface Measure {
  metric: string;
  overall: number | null;
  new: number | null;
}

/** The part of `GET /branches/{id}/file` this tool reads (`fileSchema`). */
interface FileDetail {
  path: string;
  measures: Record<string, number | null>;
  coverage: { covered: Ranges; uncovered: Ranges } | null;
  newLines: 'all' | Ranges | null;
}

const show = (v: number | null) => (v === null ? 'no value' : String(v));

/** `coverage: 90 (new code: 61.5)`; a metric without a new-code value shows the overall one only. */
function measureLine(m: Measure): string {
  return m.new === null
    ? `${m.metric}: ${show(m.overall)}`
    : `${m.metric}: ${show(m.overall)} (new code: ${show(m.new)})`;
}

function fileLines(path: string, file: FileDetail): string[] {
  const lines = [`File ${path}:`];
  for (const [metric, value] of Object.entries(file.measures)) {
    lines.push(`${metric}: ${show(value)}`);
  }
  if (!file.coverage) {
    lines.push('No line coverage was reported for this file.');
  } else {
    lines.push(
      `uncovered lines: ${file.coverage.uncovered.length ? lineRanges(file.coverage.uncovered) : 'none'}`,
      `covered lines: ${file.coverage.covered.length ? lineRanges(file.coverage.covered) : 'none'}`,
    );
  }
  if (file.newLines) {
    lines.push(`new lines: ${file.newLines === 'all' ? 'all' : lineRanges(file.newLines)}`);
  }
  return lines;
}

/** Spec §5: the measures of a branch or merge request; with a file, its coverage lines. */
export const measuresTool: McpTool<typeof input> = {
  name: 'qualor_measures',
  title: 'Measures and coverage',
  description:
    'Coverage, duplication and ratings of a branch or merge request; with file, that file’s covered and uncovered lines.',
  access: 'read',
  inputSchema: input,
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(args, { call }) {
    const project = await projectByKey(call, args.project);
    const branch = await branchOf(call, project, args);
    const measures = unwrap(await call.get<Measure[]>(`/api/v0/branches/${branch.id}/measures`));
    const file = args.file
      ? unwrap(
          await call.get<FileDetail>(`/api/v0/branches/${branch.id}/file`, { path: args.file }),
        )
      : null;
    const head = `${project.key} ${describeBranch(branch)}`;
    const text = [
      measures.length
        ? [`Measures of ${head}:`, ...measures.map(measureLine)].join('\n')
        : `${head} has no measures yet.`,
      file && args.file ? fileLines(args.file, file).join('\n') : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    return { text: truncate(text), structured: { measures, file } };
  },
};
