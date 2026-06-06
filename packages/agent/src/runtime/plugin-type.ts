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
  /** The AI SDK execute closure (single-arg or double-arg form). */
  execute: (
    input: unknown,
    options: { toolCallId: string; messages: unknown[] },
  ) => Promise<unknown>;
  /** Source identifier for telemetry `external_server_id`. */
  externalServerId: string;
}

export interface PluginTypeContributor {
  type: PluginTypeName;
  contributeTools(ctx: CapabilityContext): Promise<ContributedRawTool[]>;
}

const registry = new Map<PluginTypeName, PluginTypeContributor>();

export function registerPluginType(contributor: PluginTypeContributor): void {
  registry.set(contributor.type, contributor);
}

export function getPluginTypeContributors(): PluginTypeContributor[] {
  return [...registry.values()];
}
