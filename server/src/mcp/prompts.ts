import { z } from 'zod';

/** One MCP prompt (spec §5): a canned task the user starts from the client. */
export interface McpPrompt {
  name: string;
  title: string;
  description: string;
  argsSchema: z.ZodObject;
  messages(args: Record<string, string | undefined>): {
    role: 'user';
    content: { type: 'text'; text: string };
  }[];
}

export const fixQualityGatePrompt: McpPrompt = {
  name: 'fix_quality_gate',
  title: 'Fix the quality gate',
  description:
    'Find what blocks a branch’s or merge request’s quality gate, fix it, and check again after CI.',
  argsSchema: z.object({
    project: z.string().describe('The project key (qualor.yml)'),
    branch: z.string().optional().describe('A branch name; default: the current git branch'),
    mergeRequest: z.string().optional().describe('A merge or pull request number'),
  }),
  messages: ({ project, branch, mergeRequest }) => {
    const target = mergeRequest
      ? `merge request ${mergeRequest}`
      : branch
        ? `branch ${branch}`
        : 'the current git branch';
    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Make the Qualor quality gate of project ${project}, ${target}, pass.`,
            `1. Call qualor_gate_status for it and read the failed conditions.`,
            `2. Call qualor_issues (new code only) and qualor_issue for the ones you fix; qualor_rule and qualor_explain help when a finding is unclear.`,
            `3. Fix the code. If coverage fails, add tests for the uncovered new lines (qualor_measures with file shows them).`,
            `4. Commit and push. CI runs qualor scan; the gate is computed on the server, not locally.`,
            `5. Call qualor_gate_status with the pushed commit SHA until its state is analyzed (wait a minute or two between calls), then read the result.`,
            `Mark an issue false_positive or wont_fix with qualor_transition_issue only with a reason a reviewer would accept, and say so in your summary.`,
          ].join('\n'),
        },
      },
    ];
  },
};

export const MCP_PROMPTS: readonly McpPrompt[] = [fixQualityGatePrompt];
