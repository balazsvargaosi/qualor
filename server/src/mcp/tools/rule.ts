import { z } from 'zod';
import { truncate } from '../format';
import { unwrap } from '../inject';
import { projectByKey } from '../resolve';
import type { McpTool } from '../tool';

const input = z.object({
  project: z
    .string()
    .min(1)
    .max(400)
    .describe('A project key; the rule is read in its organisation'),
  rule: z.string().min(1).max(512).describe('A rule key, e.g. eslint:no-eval'),
});

/** Spec §5: what a rule checks, as the project's organisation sees it. */
export const ruleTool: McpTool<typeof input> = {
  name: 'qualor_rule',
  title: 'Rule description',
  description: 'What a rule checks and how to fix what it reports.',
  access: 'read',
  inputSchema: input,
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run(args, { call }) {
    const project = await projectByKey(call, args.project);
    const rule = unwrap(
      await call.get<{
        key: string;
        name: string;
        descriptionMd: string | null;
        helpUri: string | null;
        defaultSeverity: string;
        quality: string;
        cwe: number[];
      }>(`/api/v0/rules/${encodeURIComponent(args.rule)}`, {
        organizationId: project.organizationId,
      }),
    );
    const text = [
      `${rule.key} — ${rule.name} [${rule.defaultSeverity} ${rule.quality}]`,
      rule.cwe.length ? `CWE: ${rule.cwe.map((c) => `CWE-${c}`).join(', ')}` : '',
      rule.descriptionMd ?? 'No description.',
      rule.helpUri ? `More: ${rule.helpUri}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    return { text: truncate(text), structured: { rule } };
  },
};
