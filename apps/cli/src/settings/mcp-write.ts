/**
 * mcp-write.ts — Writers for `oxagen mcp add/remove/enable/disable`.
 *
 * MCP servers live in the `mcpServers` map of a single scope file. `add` writes
 * to a chosen scope (default project); `remove`/`enable`/`disable` auto-detect
 * which scope defines the server (highest precedence first) unless a scope is
 * given. Every write validates the whole document against the schema first.
 */
import type { McpServerConfig } from "@oxagen/mcp-config/schema";
import {
  getScopePaths,
  type SettingsScope,
  type ResolveSettingsOptions,
} from "./resolve.js";
import { readScopeDoc, writeScopeDoc } from "./write.js";
import type { OxagenSettings } from "./schema.js";

type Ctx = Pick<
  ResolveSettingsOptions,
  "cwd" | "userSettingsPath" | "projectDirName"
>;

const SCOPE_ORDER: SettingsScope[] = ["local", "project", "user"];

function serversOf(
  doc: Record<string, unknown>,
): Record<string, McpServerConfig> {
  return (
    (doc["mcpServers"] as Record<string, McpServerConfig> | undefined) ?? {}
  );
}

/** Find the highest-precedence scope that defines a server, if any. */
export function findServerScope(
  name: string,
  ctx: Ctx = {},
): { scope: SettingsScope; path: string } | null {
  const paths = getScopePaths(ctx);
  for (const scope of SCOPE_ORDER) {
    const path = paths[scope];
    if (name in serversOf(readScopeDoc(path))) return { scope, path };
  }
  return null;
}

export interface WriteMcpServerOptions extends Ctx {
  scope?: SettingsScope;
  name: string;
  config: McpServerConfig;
}

/** Add or replace an MCP server in a scope file (default: project). */
export function writeMcpServer(opts: WriteMcpServerOptions): string {
  const scope = opts.scope ?? "project";
  const path = getScopePaths(opts)[scope];
  const doc = readScopeDoc(path);
  const servers = serversOf(doc);
  servers[opts.name] = opts.config;
  doc["mcpServers"] = servers;
  writeScopeDoc(path, doc as OxagenSettings);
  return path;
}

export interface McpMutateOptions extends Ctx {
  scope?: SettingsScope;
  name: string;
}

/** Remove a server. Returns the path touched and whether it existed. */
export function removeMcpServer(opts: McpMutateOptions): {
  path: string;
  found: boolean;
} {
  const target = opts.scope
    ? { scope: opts.scope, path: getScopePaths(opts)[opts.scope] }
    : findServerScope(opts.name, opts);
  if (!target) return { path: getScopePaths(opts).project, found: false };
  const doc = readScopeDoc(target.path);
  const servers = serversOf(doc);
  if (!(opts.name in servers)) return { path: target.path, found: false };
  delete servers[opts.name];
  doc["mcpServers"] = servers;
  writeScopeDoc(target.path, doc as OxagenSettings);
  return { path: target.path, found: true };
}

/** Toggle a server's `disabled` flag. Returns the path and whether it existed. */
export function setMcpServerDisabled(
  opts: McpMutateOptions & { disabled: boolean },
): { path: string; found: boolean } {
  const target = opts.scope
    ? { scope: opts.scope, path: getScopePaths(opts)[opts.scope] }
    : findServerScope(opts.name, opts);
  if (!target) return { path: getScopePaths(opts).project, found: false };
  const doc = readScopeDoc(target.path);
  const servers = serversOf(doc);
  const existing = servers[opts.name];
  if (!existing) return { path: target.path, found: false };
  servers[opts.name] = { ...existing, disabled: opts.disabled };
  doc["mcpServers"] = servers;
  writeScopeDoc(target.path, doc as OxagenSettings);
  return { path: target.path, found: true };
}
