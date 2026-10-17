import { z } from 'zod';
import { unwrap } from '../inject';
import type { McpTool } from '../tool';

interface Project {
  id: string;
  key: string;
  name: string;
}

const PAGE = 100;

const input = z.object({
  query: z.string().min(1).max(200).optional().describe('Part of a project key or name'),
});

/** Spec §5: the projects the user can see, so the agent can map qualor.yml's key to the rest. */
export const projectsTool: McpTool<typeof input> = {
  name: 'qualor_projects',
  title: 'List Qualor projects',
  description:
    'The Qualor projects you can see. A project key is what qualor.yml names; pass it to the other tools.',
  access: 'read',
  inputSchema: input,
  annotations: { readOnlyHint: true, openWorldHint: false },
  async run({ query }, { call }) {
    const page = unwrap(
      await call.get<{ items: Project[]; nextCursor: string | null }>('/api/v0/projects', {
        limit: PAGE,
        q: query,
      }),
    );
    const projects = page.items.map((p) => ({ id: p.id, key: p.key, name: p.name }));
    const truncated = page.nextCursor !== null;
    const lines = projects.map((p) => `${p.key} — ${p.name}`);
    if (truncated) lines.push(`More than ${PAGE} projects match; narrow them with query.`);
    const text = projects.length ? lines.join('\n') : 'No projects you can see match.';
    return { text, structured: { projects, truncated } };
  },
};
