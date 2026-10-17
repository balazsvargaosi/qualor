import type { McpTool } from '../tool';
import { gateStatusTool } from './gate-status';
import { issueTool } from './issue';
import { issuesTool } from './issues';
import { measuresTool } from './measures';
import { projectsTool } from './projects';
import { ruleTool } from './rule';

/** Every tool `/mcp` serves (spec §5); Tasks 11–13 append theirs. */
export const MCP_TOOLS: readonly McpTool[] = [
  projectsTool,
  gateStatusTool,
  issuesTool,
  issueTool,
  ruleTool,
  measuresTool,
] as readonly McpTool[];
