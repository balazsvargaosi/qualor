import type { McpTool } from '../tool';
import { projectsTool } from './projects';

/** Every tool `/mcp` serves (spec §5); Tasks 10–13 append theirs. */
export const MCP_TOOLS: readonly McpTool[] = [projectsTool];
