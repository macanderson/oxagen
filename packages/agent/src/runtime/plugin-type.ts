/**
 * The installable-plugin spine. Each PluginType contributes *raw* agent tools
 * for the enabled, non-denied, installed plugins of its type in the given
 * context. The cross-cutting IAM gate + ClickHouse telemetry wrapping is applied
 * uniformly by materializeTools (one place, not per type), so contributors stay
 * focused on the type-specific work (governance query, connect, decrypt, list).
 *
 * Extensibility: adding a type = registerPluginType(...) with a contributeTools
 * impl; deepening Integration/Content-tool verticals = filling in their impls.
 * The spine, governance, and runtime wrapping never change.
 */
import type { PluginType as PluginTypeName } from "@oxagen/database";
import type { CapabilityContext } from "../types";

/** A raw tool contributed by a plugin, before IAM/telemetry wrapping. */
export interface ContributedRawTool {
  /** The synthetic capability id, e.g. `mcp.<serverId>.<toolName>`. */
  realName: string;
  description?: string;
  /**
   * The tool's JSONSchema input contract. For DB-backed external MCP servers
   * this is the PINNED schema (descriptor pinning, runtime/mcp-snapshots.ts).
   * When present, materializeTools presents it to the model via jsonSchema();
   * absent, the permissive object-schema fallback applies.
   */
  inputSchema?: Record<string, unknown>;
  /** The AI SDK execute closure (single-arg or double-arg form). */
  execute: (
    input: unknown,
    options: { toolCallId: string; messages: unknown[] },
  ) => Promise<unknown>;
  /** Source identifier for telemetry `external_server_id`. */
  externalServerId: string;
  /**
   * Human-facing server name (mcp_servers.name / settings server key) — the
   * identity Agent-RBAC "server:tool" rule patterns address (spec §3.7).
   * materializeTools falls back to externalServerId when absent; a blanket
   * "*" deny still matches either way.
   */
  externalServerName?: string;
  /** Bare tool name (no server prefix) for the "server:tool" rule key. */
  externalToolName?: string;
}

export interface PluginContributeOptions {
  /** When provided, only servers whose publicId is in this set are loaded. */
  serverAllowlist?: Set<string>;
}

export interface PluginTypeContributor {
  type: PluginTypeName;
  contributeTools(
    ctx: CapabilityContext,
    options?: PluginContributeOptions,
  ): Promise<ContributedRawTool[]>;
}

const registry = new Map<PluginTypeName, PluginTypeContributor>();

export function registerPluginType(contributor: PluginTypeContributor): void {
  registry.set(contributor.type, contributor);
}

export function getPluginTypeContributors(): PluginTypeContributor[] {
  return [...registry.values()];
}
