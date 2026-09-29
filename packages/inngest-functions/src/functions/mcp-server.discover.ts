// mcp-server.discover.ts: one MCP server's discovery (lane M10, #4682;
// mcp-studio-spec, Sync).
//
// Studio, the gateway's list_changed notification, the catalog's newer
// registry version, a push to a definition, and the hourly sweep send
// `mcp-server/discover.requested`. The run reads the server's tools, writes
// them to mcp.tool_snapshots, and opens or updates one sync steering PR when
// an imported tool's upstream moved.
//
// One discovery runs at a time per server, keyed by `event.data.key`, so two
// requests for one server never open two PRs.
import { NonRetriableError } from "@oxagen/functions";

import { createFunction } from "../create-function";
import {
  mcpServerDiscoveryRunner,
  type McpServerDiscoveryData,
} from "../lib/mcp-server-discovery-runner";

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The event's data, or null when a field is missing. */
export function discoveryData(data: unknown): McpServerDiscoveryData | null {
  if (data === null || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const orgId = text(d["orgId"]);
  const workspaceId = text(d["workspaceId"]);
  const server = text(d["server"]);
  const trigger = text(d["trigger"]);
  const key = text(d["key"]);
  if (!orgId || !workspaceId || !server || !trigger || !key) return null;
  const requestedBy = text(d["requestedBy"]);
  return {
    orgId,
    workspaceId,
    server,
    trigger,
    key,
    ...(requestedBy === null ? {} : { requestedBy }),
  };
}

/**
 * One discovery, with a refusal the runner marked non-retriable rethrown as
 * the error Inngest recognises inside a step.
 */
async function runOnce(data: McpServerDiscoveryData) {
  try {
    return await mcpServerDiscoveryRunner().run(data);
  } catch (err) {
    if (
      err !== null &&
      typeof err === "object" &&
      (err as { isNonRetriable?: unknown }).isNonRetriable === true
    )
      throw new NonRetriableError(
        err instanceof Error ? err.message : String(err),
        { cause: err },
      );
    throw err;
  }
}

export const [mcpServerDiscover] = createFunction(
  {
    id: "mcp-server/discover",
    retries: 2,
    concurrency: { limit: 1, key: "event.data.key" },
    timeouts: { finish: "10m" },
  },
  { event: "mcp-server/discover.requested" },
  async ({ event, step }) => {
    const data = discoveryData(event.data);
    if (data === null)
      throw new NonRetriableError(
        "mcp-server/discover.requested is missing orgId, workspaceId, server, trigger, or key",
      );
    return step.run("discover", () => runOnce(data));
  },
);
