import { z } from "zod";
import { registerCapability } from "../registry";

// `list_sandboxes` enumerates the durable sandbox sessions in the caller's
// workspace (rows in `sandbox_sessions`, created by `agent.sandbox.start`), so
// the app's "sandbox detail" page — plus CLI/MCP/agent callers — can show which
// sessions exist, their lifecycle status, and when each was last used, without
// probing every session id individually. Read-only: it never touches a live
// driver (unlike the other `agent.sandbox.*` capabilities, it only reads the
// Postgres registry), so it works regardless of whether a durable driver is
// configured and consumes no AI tokens — hence `noBillingGate: true`.
//
// Scoped by org + workspace via the capability context (no org/ws in the
// input). Ordered most-recently-used first so the newest activity surfaces at
// the top of the list.
export const agentSandboxList = registerCapability({
  name: "list_sandboxes",
  domain: "agent",
  description:
    "List the durable sandbox sessions in the current workspace (id, key, image, status, driver, last-used/expiry timestamps), most-recently-used first.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "execution" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    status: z
      .enum(["running", "idle", "stopped", "gone"])
      .optional()
      .describe(
        "Filter to sessions in this lifecycle status. Omit to include every non-deleted session.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe("Maximum number of sessions to return (1-100, default 50)."),
  }),
  output: z.object({
    sandboxes: z.array(
      z.object({
        sessionId: z
          .string()
          .describe("Opaque durable-session id (sbx_…) — the public id column."),
        sessionKey: z
          .string()
          .nullable()
          .describe("Caller-supplied reuse key, or null for ephemeral sessions."),
        image: z.enum(["node", "python", "shell", "agent"]),
        status: z.enum(["running", "idle", "stopped", "gone"]),
        driver: z.string().describe("Sandbox driver identifier (e.g. modal)."),
        lastUsedAt: z
          .string()
          .nullable()
          .describe("ISO timestamp of the most recent interaction, or null."),
        expiresAt: z
          .string()
          .nullable()
          .describe("ISO soft-expiry timestamp, or null when the session has no expiry."),
        createdAt: z.string().describe("ISO timestamp the session was created."),
      }),
    ),
  }),
});

export type AgentSandboxListInput = z.output<typeof agentSandboxList.input>;
export type AgentSandboxListOutput = z.output<typeof agentSandboxList.output>;
