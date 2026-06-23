/**
 * first-party-mcp.ts — Static descriptors for first-party MCP server integrations.
 *
 * Each entry describes a hosted MCP server that Oxagen surfaces as a
 * featured/first-party integration. These descriptors are used by the
 * install flow to populate `plugin.installed_plugins` with the correct
 * endpoint + auth metadata — WITHOUT requiring a registry lookup.
 *
 * Endpoint source:
 *   GitHub MCP: https://api.githubcopilot.com/mcp/
 *   (GitHub's hosted remote MCP server, announced 2025-04-04; uses MCP OAuth 2.1)
 */

export interface FirstPartyMcpServer {
  /** Canonical name stored in plugin.installed_plugins.name */
  readonly name: string;
  /** Human-readable title shown in the UI */
  readonly title: string;
  /** One-sentence summary */
  readonly description: string;
  /** Hosted MCP server URL */
  readonly endpointUrl: string;
  /** Transport protocol */
  readonly transport: "streamable-http";
  /** Auth kind — oauth means MCP OAuth 2.1 flow via DbOAuthClientProvider */
  readonly authKind: "oauth" | "secret" | "none";
  /** SVG or URL icon; null means fall back to a generic plug icon */
  readonly iconUrl: string | null;
  /** Plugin type stored in plugin.installed_plugins.plugin_type */
  readonly pluginType: "mcp_server";
}

export const GITHUB_MCP_SERVER = {
  name: "github-mcp",
  title: "GitHub MCP",
  description:
    "Read repositories, create branches, open pull requests, list and comment on issues — all via GitHub's hosted MCP server.",
  endpointUrl: "https://api.githubcopilot.com/mcp/",
  transport: "streamable-http",
  authKind: "oauth",
  iconUrl:
    "https://github.githubassets.com/favicons/favicon.svg",
  pluginType: "mcp_server",
} as const satisfies FirstPartyMcpServer;

/** All first-party MCP servers, in display order. */
export const FIRST_PARTY_MCP_SERVERS: readonly FirstPartyMcpServer[] = [
  GITHUB_MCP_SERVER,
];
