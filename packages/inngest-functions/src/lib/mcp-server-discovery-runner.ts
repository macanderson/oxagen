// mcp-server-discovery-runner.ts: the seam between the durable MCP server
// discovery (functions/mcp-server.discover.ts and mcp-server.sync.ts) and the
// code that performs it (lane M10, #4682).
//
// Discovery reads the steering repo and writes mcp.server_discoveries through
// `@oxagen/handlers`, and `@oxagen/handlers` depends on this package, so this
// package cannot import it. The handlers' register module installs the runner
// when the API process boots, before the Inngest route can invoke a function.

/** One `mcp-server/discover.requested` event's data. */
export type McpServerDiscoveryData = {
  orgId: string;
  workspaceId: string;
  /** The folder name under tools/servers/. */
  server: string;
  /** schedule, list_changed, push, registry_version, manual, or lock_merged. */
  trigger: string;
  /** One discovery at a time per server: `<orgId>:<workspaceId>:<server>`. */
  key: string;
  requestedBy?: string;
};

/** One event the hourly sweep sends. */
export type McpServerDiscoveryRequest = {
  name: "mcp-server/discover.requested";
  data: McpServerDiscoveryData;
  /** Deduplicates a second sweep in the same hour. */
  id?: string;
};

/** What one discovery did. */
export type McpServerDiscoveryResult = {
  server: string;
  status: string;
  outcome: string | null;
  toolCount: number | null;
  withheld: string[];
  pr: { number: number; url: string; branch: string } | null;
  error: string | null;
};

export interface McpServerDiscoveryRunner {
  /** Run one discovery. A malformed event throws with `isNonRetriable`. */
  run(data: McpServerDiscoveryData): Promise<McpServerDiscoveryResult>;
  /** The events the hourly sweep sends at `now`. */
  sweep(now: Date): Promise<McpServerDiscoveryRequest[]>;
}

let runner: McpServerDiscoveryRunner | null = null;

/** Install the runner. `@oxagen/handlers/register` calls this at boot. */
export function setMcpServerDiscoveryRunner(
  next: McpServerDiscoveryRunner,
): void {
  runner = next;
}

/** The installed runner; throws in a process that booted without handlers. */
export function mcpServerDiscoveryRunner(): McpServerDiscoveryRunner {
  if (!runner)
    throw new Error(
      "[mcp-server.discover] no discovery runner is installed; import @oxagen/handlers/register before serving Inngest functions",
    );
  return runner;
}
