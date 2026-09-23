import { z } from "zod";
import { registerCapability } from "../registry";

const count = z.number().int().nonnegative();

export const contextSteeringDeliveries = registerCapability({
  name: "get_steering_deliveries",
  domain: "context",
  description:
    "Read included and cut steering records from the latest verified manifest of recent runs.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Compliance: "allow" },
    workspace: {
      Owner: "allow",
      Admin: "allow",
      Member: "allow",
      Viewer: "allow",
      Compliance: "allow",
    },
  },
  input: z
    .object({
      days: z.number().int().min(1).max(30).default(7),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .strict(),
  output: z.object({
    runs: z.array(
      z.object({
        sessionUuid: z.string().uuid(),
        ts: z.string(),
        harness: z.string(),
        agentKey: z.string(),
        recordsIncluded: count,
        recordsCut: count,
        recordsCutForBudget: count,
        budgetTokens: count,
        spentTokens: count,
      }),
    ),
    undelivered: z.array(
      z.object({
        recordId: z.string(),
        runs: count,
        lastReason: z.string(),
        lastSeen: z.string(),
      }),
    ),
    scanned: count,
    truncated: z.boolean(),
  }),
});
