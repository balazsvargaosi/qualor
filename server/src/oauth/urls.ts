/** Every URL the authorization server and the MCP endpoint publish (spec §3). */
export interface McpUrls {
  issuer: string;
  resource: string;
  /** RFC 9728 §3.1: `/.well-known/oauth-protected-resource` inserted before the resource's path. */
  resourceMetadata: string;
  /** RFC 8414 §3.1: `/.well-known/oauth-authorization-server` inserted before the issuer's path. */
  authorizationServerMetadata: string;
  authorize: string;
  token: string;
  revoke: string;
  register: string;
}

/** Null without QUALOR_PUBLIC_URL: OAuth and MCP are then off (spec §3). */
export function mcpUrls(publicUrl: string | null): McpUrls | null {
  if (publicUrl === null) return null;
  const issuer = publicUrl.replace(/\/+$/, '');
  const { origin, pathname } = new URL(issuer);
  const path = pathname === '/' ? '' : pathname;
  return {
    issuer,
    resource: `${issuer}/mcp`,
    resourceMetadata: `${origin}/.well-known/oauth-protected-resource${path}/mcp`,
    authorizationServerMetadata: `${origin}/.well-known/oauth-authorization-server${path}`,
    authorize: `${issuer}/oauth/authorize`,
    token: `${issuer}/oauth/token`,
    revoke: `${issuer}/oauth/revoke`,
    register: `${issuer}/oauth/register`,
  };
}
