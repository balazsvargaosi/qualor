import { z } from 'zod';
import type { Executor } from '../db/client';
import { instanceSettings } from '../db/schema';
import { instanceSetting } from '../settings';

export const MCP_POLICY_KEY = 'mcp.oauth';

/** An exact client id (`qlr_cli_�` or a CIMD URL), or a URL prefix ending in `/`. */
const allowEntry = z.string().min(1).max(2048).regex(/^\S+$/);

/** Spec �9: which OAuth clients may connect to the MCP endpoint. */
export const mcpPolicySchema = z.strictObject({
  dcr: z.boolean(),
  cimd: z.boolean(),
  allowedClients: z.array(allowEntry).max(100),
});
export type McpPolicy = z.infer<typeof mcpPolicySchema>;

export const DEFAULT_MCP_POLICY: McpPolicy = Object.freeze({
  dcr: true,
  cimd: true,
  allowedClients: [],
}) as McpPolicy;

export function readMcpPolicy(db: Executor): Promise<McpPolicy> {
  return instanceSetting(db, MCP_POLICY_KEY, mcpPolicySchema, DEFAULT_MCP_POLICY);
}

export async function writeMcpPolicy(db: Executor, policy: McpPolicy): Promise<void> {
  await db
    .insert(instanceSettings)
    .values({ key: MCP_POLICY_KEY, value: policy })
    .onConflictDoUpdate({
      target: instanceSettings.key,
      set: { value: policy, updatedAt: new Date() },
    });
}
