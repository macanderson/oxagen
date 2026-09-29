// types.ts: the shapes discovery and sync share (lane M10, #4682;
// mcp-studio-spec, Sync).
import type { schema } from "@oxagen/database";

/** The workspace whose steering repo holds the server folder. */
export interface DiscoveryScope {
  orgId: string;
  workspaceId: string;
}

/**
 * What asked for a discovery:
 *
 * - schedule: the hourly sweep, for a server whose sync.schedule is daily.
 * - list_changed: the MCP server's notifications/tools/list_changed.
 * - push: a push that changed the definition in a linked repository.
 * - registry_version: the catalog published a newer version.
 * - manual: a person asked in Studio.
 * - lock_merged: the sync PR merged or closed.
 */
export type DiscoveryTrigger = (typeof schema.MCP_DISCOVERY_TRIGGERS)[number];

/** How a finished discovery ended. */
export type DiscoveryOutcome = (typeof schema.MCP_DISCOVERY_OUTCOMES)[number];

/** A server's sync.schedule, from server.toml. */
export type SyncSchedule = "on-change" | "daily" | "manual";

/** One `mcp-server/discover.requested` event's data. */
export interface DiscoveryEventData {
  orgId: string;
  workspaceId: string;
  /** The folder name under tools/servers/. */
  server: string;
  trigger: DiscoveryTrigger;
  /** One discovery at a time per server: `<orgId>:<workspaceId>:<server>`. */
  key: string;
  /** The person who asked, for a manual discovery. */
  requestedBy?: string;
}

/** The concurrency key for one server. */
export function discoveryKey(scope: DiscoveryScope, server: string): string {
  return `${scope.orgId}:${scope.workspaceId}:${server}`;
}

/** Why discovery stopped before it could compare the tools. */
export type DiscoveryRefusalCode =
  | "no_server"
  | "server_file"
  | "credential"
  | "source"
  | "unsupported"
  | "needs_digest"
  | "opener";

/** A refusal whose message a person can act on. It never holds a credential. */
export class DiscoveryRefused extends Error {
  readonly code: DiscoveryRefusalCode;

  constructor(code: DiscoveryRefusalCode, message: string) {
    super(message);
    this.name = "DiscoveryRefused";
    this.code = code;
  }
}

/** What one discovery did, for the Inngest run's output and for tests. */
export interface DiscoveryResult {
  server: string;
  status: "succeeded" | "failed";
  outcome: DiscoveryOutcome | null;
  toolCount: number | null;
  withheld: string[];
  pr: { number: number; url: string; branch: string } | null;
  error: string | null;
}
