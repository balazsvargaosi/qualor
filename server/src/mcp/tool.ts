import type { z } from 'zod';
import type { OAuthPrincipal } from '../auth/principal';
import type { McpCaller } from './inject';

/** Which REST calls a tool may make (spec §4.4, ruling R1); also its MCP scope. */
export type ToolAccess = 'read' | 'ai' | 'write';

export interface ToolContext {
  call: McpCaller;
  principal: Omit<OAuthPrincipal, 'scopes'>;
}

/** What a tool answers: a compact text for the agent and the same facts as structured content. */
export interface ToolOutput {
  text: string;
  structured: Record<string, unknown>;
}

/** One MCP tool (spec §5): its input schema, its access and an adapter over REST calls. */
export interface McpTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  access: ToolAccess;
  inputSchema: S;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolOutput>;
}

/** A failure the agent reads: the REST problem code and a sentence. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/** The MCP scope a tool needs: read and AI tools `mcp:read`, the write tool `mcp:write`. */
export function requiredScope(access: ToolAccess): 'mcp:read' | 'mcp:write' {
  return access === 'write' ? 'mcp:write' : 'mcp:read';
}
