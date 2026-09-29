// mcp-server.sync.ts: the hourly discovery sweep (lane M10, #4682;
// mcp-studio-spec, Sync).
//
// Every hour the sweep asks for a discovery of each published server that
// was never discovered, of each daily server whose last discovery is a day
// old, and of each server with an open sync steering PR, so a merge releases
// the tools discovery withheld. Each event carries an id for the hour, so a
// retried sweep sends nothing twice.
import { createFunction } from "../create-function";
import { mcpServerDiscoveryRunner } from "../lib/mcp-server-discovery-runner";

export const [mcpServerSync] = createFunction(
  { id: "mcp-server/sync", retries: 1, concurrency: { limit: 1 } },
  { cron: "0 * * * *" },
  async ({ step }) => {
    const requests = await step.run("plan-discoveries", () =>
      mcpServerDiscoveryRunner().sweep(new Date()),
    );
    if (requests.length === 0) return { requested: 0 };
    await step.sendEvent("request-discoveries", requests);
    return { requested: requests.length };
  },
);
