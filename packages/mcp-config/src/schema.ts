/**
 * schema.ts — Zod schemas for the file-based MCP configuration system.
 *
 * Defines the shape of:
 *   - MCP server definitions (transport, auth, env)
 *   - Permission rules (allow/deny/ask per server + tool)
 *   - Tool visibility (include/exclude per server)
 *   - The top-level settings.json structure
 *
 * These schemas are used for:
 *   1. Validation at load time (parse settings files)
 *   2. Type inference (TypeScript types derived from schemas)
 *   3. JSON Schema generation (for editor autocompletion)
 */
import { z } from "zod";

// ── Transport Definitions ─────────────────────────────────────────────────────

// `url` on the three network transports below is only checked for non-emptiness,
// not parsed as a URL — unlike `oauthServerUrl`, which uses .url(). A malformed
// or non-http scheme therefore survives validation and fails later at connect
// time. Tightening it is a compatibility decision (it would reject configs that
// load today), so it is deliberately left loose here rather than changed in
// passing.
const streamableHttpServerSchema = z.object({
  transport: z.literal("streamable-http"),
  url: z.string().min(1),
  /** Auth strategy for this server. */
  auth: z.enum(["oauth", "bearer", "header", "none"]).default("none"),
  /** For OAuth: the server URL that exposes .well-known/oauth-authorization-server. */
  oauthServerUrl: z.string().url().optional(),
  /** OAuth scopes to request during the authorize flow. */
  scopes: z.array(z.string()).optional(),
  /** Env var name that holds the bearer token. Resolved at runtime. */
  envToken: z.string().optional(),
  /** Static/env-expanded headers for header auth. */
  headers: z.record(z.string()).optional(),
  /** Additional environment variables passed to the transport. */
  env: z.record(z.string()).optional(),
  /** Whether this server is disabled (present in config but not loaded). */
  disabled: z.boolean().optional(),
});

const sseServerSchema = z.object({
  transport: z.literal("sse"),
  url: z.string().min(1),
  auth: z.enum(["oauth", "bearer", "header", "none"]).default("none"),
  oauthServerUrl: z.string().url().optional(),
  scopes: z.array(z.string()).optional(),
  envToken: z.string().optional(),
  headers: z.record(z.string()).optional(),
  env: z.record(z.string()).optional(),
  disabled: z.boolean().optional(),
});

const stdioServerSchema = z.object({
  transport: z.literal("stdio"),
  /** The command to spawn (e.g. "npx", "node", "python"). */
  command: z.string().min(1),
  /** Arguments passed to the command. Supports ${VAR} expansion. */
  args: z.array(z.string()).default([]),
  /** Environment variables set for the spawned process. */
  env: z.record(z.string()).optional(),
  /** Working directory for the spawned process. Defaults to project root. */
  cwd: z.string().optional(),
  disabled: z.boolean().optional(),
});

const websocketServerSchema = z.object({
  transport: z.literal("websocket"),
  url: z.string().min(1),
  auth: z.enum(["bearer", "header", "none"]).default("none"),
  envToken: z.string().optional(),
  headers: z.record(z.string()).optional(),
  env: z.record(z.string()).optional(),
  disabled: z.boolean().optional(),
});

/** Union of all supported MCP server transport definitions. */
export const mcpServerSchema = z.discriminatedUnion("transport", [
  streamableHttpServerSchema,
  sseServerSchema,
  stdioServerSchema,
  websocketServerSchema,
]);

export type McpServerConfig = z.infer<typeof mcpServerSchema>;

// ── Permission Rules ──────────────────────────────────────────────────────────

/** Per-server permission overrides. */
export const serverPermissionSchema = z.object({
  /** Default policy for tools on this server when no rule matches. */
  defaultPolicy: z.enum(["allow", "deny", "ask"]).optional(),
  /** Glob patterns for tool names that are always allowed. */
  allow: z.array(z.string()).optional(),
  /** Glob patterns for tool names that are always denied. */
  deny: z.array(z.string()).optional(),
});

export type ServerPermission = z.infer<typeof serverPermissionSchema>;

export const permissionsSchema = z.object({
  /** Global default policy for MCP tool invocations. */
  defaultMcpPolicy: z.enum(["allow", "deny", "ask"]).default("ask"),
  /** Per-server permission overrides. Keyed by server name. */
  mcpServers: z.record(serverPermissionSchema).optional(),
});

export type Permissions = z.infer<typeof permissionsSchema>;

// ── Tool Visibility ───────────────────────────────────────────────────────────

/** Controls which tools from a server are advertised to the model. */
export const toolVisibilitySchema = z.object({
  /** Whitelist: only these tools are shown. Omit to show all. Glob patterns. */
  include: z.array(z.string()).optional(),
  /** Blacklist: these tools are hidden. Applied after include. Glob patterns. */
  exclude: z.array(z.string()).optional(),
});

export type ToolVisibility = z.infer<typeof toolVisibilitySchema>;

// ── Top-Level Settings File ───────────────────────────────────────────────────

export const settingsSchema = z.object({
  $schema: z.string().optional(),
  /** MCP server definitions. Keyed by a user-chosen name (e.g. "github"). */
  mcpServers: z.record(mcpServerSchema).optional(),
  /** Permission rules for MCP tool invocations. */
  permissions: permissionsSchema.optional(),
  /** Tool visibility rules per server. Keyed by server name. */
  toolVisibility: z.record(toolVisibilitySchema).optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

// ── Managed Policy (Org-Level) ────────────────────────────────────────────────

export const managedPolicySchema = z.object({
  /** Glob patterns for server URLs that are permitted. Empty = all allowed. */
  allowedServerUrls: z.array(z.string()).optional(),
  /** Glob patterns for stdio commands that are permitted. Empty = all allowed. */
  allowedCommands: z.array(z.string()).optional(),
  /** Glob patterns for server URLs that are always blocked. */
  deniedServerUrls: z.array(z.string()).optional(),
  /** Glob patterns for tool names that are always blocked (any server). */
  deniedTools: z.array(z.string()).optional(),
});

export type ManagedPolicy = z.infer<typeof managedPolicySchema>;

export const managedConfigSchema = z.object({
  _managed: z.literal(true),
  _orgId: z.string(),
  _syncedAt: z.string(),
  /** Org-provisioned servers that users cannot remove or override auth for. */
  mcpServers: z
    .record(mcpServerSchema.and(z.object({ managed: z.literal(true) })))
    .optional(),
  /** Org-level allowlist/denylist enforcement. */
  managedPolicy: managedPolicySchema.optional(),
});

export type ManagedConfig = z.infer<typeof managedConfigSchema>;
