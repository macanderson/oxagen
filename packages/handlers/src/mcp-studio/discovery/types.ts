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

/**
 * One `mcp-server/discover.requested` event's data. A type alias, not an
 * interface, so it is assignable to an event payload's record type.
 */
export type DiscoveryEventData = {
  orgId: string;
  workspaceId: string;
  /** The folder name under tools/servers/. */
  server: string;
  trigger: DiscoveryTrigger;
  /** One discovery at a time per server: `<orgId>:<workspaceId>:<server>`. */
  key: string;
  /** The person who asked, for a manual discovery. */
  requestedBy?: string;
};

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
  | "no_opener"
  | "opener";

/** A refusal whose message a person can act on. It never holds a credential. */
export class DiscoveryRefused extends Error {
  readonly code: DiscoveryRefusalCode;
  /**
   * True when the same request can succeed later, as after an outage or a
   * timeout. False when it fails the same way until someone changes a file,
   * a credential, or a setting.
   */
  readonly retriable: boolean;

  constructor(
    code: DiscoveryRefusalCode,
    message: string,
    options: { retriable?: boolean } = {},
  ) {
    super(message);
    this.name = "DiscoveryRefused";
    this.code = code;
    this.retriable = options.retriable ?? false;
  }
}

/**
 * A server that runs on machines, discovered in a process that reaches none
 * (#4772). The API's durable functions throw it from their local reporter,
 * and runDiscovery records the row as waiting_for_machine with the groups
 * that may run it. The MCP process a machine in those groups polls claims the
 * row and runs the discovery through its broker. It is not a failure.
 */
export class WaitingForMachine extends Error {
  /** server.toml's source.machines: the groups whose machines may run it. */
  readonly groups: readonly string[];

  constructor(server: string, groups: readonly string[]) {
    super(
      `${server} runs on machines in ${groups.join(", ") || "no group"}. Its discovery waits for one of them to poll.`,
    );
    this.name = "WaitingForMachine";
    this.groups = groups;
  }
}

/**
 * A discovery that failed for a reason that can pass. runDiscovery records
 * the failure on the row first, then throws this so the durable function
 * retries. Its message is the row's, with every credential removed.
 */
export class RetriableDiscoveryFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetriableDiscoveryFailure";
  }
}

/** What one discovery did, for the Inngest run's output and for tests. */
export interface DiscoveryResult {
  server: string;
  status: "succeeded" | "failed" | "waiting_for_machine";
  outcome: DiscoveryOutcome | null;
  toolCount: number | null;
  withheld: string[];
  pr: { number: number; url: string; branch: string } | null;
  error: string | null;
}
