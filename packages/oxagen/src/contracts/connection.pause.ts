import { z } from "zod";
import { registerCapability } from "../registry";

// Pause or resume syncing for a source connection. Pausing stops further
// ingestion without tearing down the connection or its data; resuming returns
// it to the connected state. Only valid for connections that are connected or
// already paused (not pending_setup / error).
export const connectionPause = registerCapability({
  name: "pause_connection",
  domain: "connection",
  description:
    "Pause or resume syncing for a data source connection. Pausing stops ingestion while keeping the connection and its data intact; resuming returns it to connected.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "connection" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    connectionId: z
      .string()
      .min(1)
      .describe("Public ID or internal UUID of the connection"),
    paused: z
      .boolean()
      .describe("true = pause syncing; false = resume syncing"),
  }),
  output: z.object({
    connectionId: z.string(),
    status: z
      .enum(["connected", "paused"])
      .describe("Resulting connection status"),
  }),
});

export type ConnectionPauseInput = z.output<typeof connectionPause.input>;
export type ConnectionPauseOutput = z.output<typeof connectionPause.output>;
