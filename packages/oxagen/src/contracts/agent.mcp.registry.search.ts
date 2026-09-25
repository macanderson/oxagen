import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * The transports a registry entry can declare. Oxagen reaches a provider over
 * `streamable-http`; an `sse` remote or a `stdio` package is listed so a person
 * can see the server exists, and is not offered as connectable.
 */
export const mcpRegistryTransport = z.enum(["streamable-http", "sse", "stdio"]);

/**
 * How a server authenticates a client. `oauth` is read live from the server's
 * protected-resource metadata or its 401 challenge, because the registry's
 * server.json cannot say it. `unknown` is a server nobody could probe.
 */
export const mcpRegistryAuth = z.enum([
  "oauth",
  "bearer",
  "header",
  "none",
  "unknown",
]);

export const mcpRegistryServer = z.object({
  /** The registry name (`app.linear/linear`), or `verified/<slug>` for a first-party entry. */
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** Who publishes it: the verified domain, or the GitHub account for `io.github.*`. */
  publisher: z.string(),
  /**
   * True when the publisher proved it owns the name: a first-party entry, or a
   * registry namespace verified by DNS or HTTP. An `io.github.<user>` name is
   * verified only as that GitHub account, which is not a company.
   */
  publisherVerified: z.boolean(),
  source: z.enum(["verified", "registry"]),
  version: z.string().nullable(),
  /** An https icon URL, or null. */
  iconUrl: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  docsUrl: z.string().nullable(),
  repositoryUrl: z.string().nullable(),
  /** The streamable-http endpoint Oxagen would connect to, or null. */
  endpointUrl: z.string().nullable(),
  transports: z.array(mcpRegistryTransport),
  auth: mcpRegistryAuth,
  /** The header a `bearer` or `header` server wants, as the registry names it. */
  authHeader: z.string().nullable(),
  /**
   * For an OAuth server: `dynamic` registers a client itself, `client_required`
   * needs an OAuth app the workspace brings (Slack, GitHub), `unknown` was not
   * read. Null for a server that does not use OAuth.
   */
  oauthRegistration: z
    .enum(["dynamic", "client_required", "unknown"])
    .nullable(),
  /** False for a server with no streamable-http endpoint Oxagen can reach. */
  connectable: z.boolean(),
});

export const agentMcpRegistrySearch = registerCapability({
  name: "search_mcp_registry",
  domain: "agent",
  description:
    "Search the official MCP Registry and Oxagen's verified first-party servers for MCP servers a workspace can add as a tool provider",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    /** Free text matched against name, title and description. Empty lists verified servers first. */
    query: z.string().max(120).default(""),
    /** The `nextCursor` of the page before. */
    cursor: z.string().max(400).optional(),
    limit: z.number().int().min(1).max(30).default(20),
  }),
  output: z.object({
    servers: z.array(mcpRegistryServer),
    nextCursor: z.string().nullable(),
    /** False when the registry could not be read; the verified entries still answer. */
    registryReachable: z.boolean(),
  }),
});

export type AgentMcpRegistrySearchInput = z.output<
  typeof agentMcpRegistrySearch.input
>;
export type AgentMcpRegistrySearchOutput = z.output<
  typeof agentMcpRegistrySearch.output
>;
export type McpRegistryServer = z.output<typeof mcpRegistryServer>;
