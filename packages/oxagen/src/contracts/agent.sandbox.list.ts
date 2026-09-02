import { z } from "zod";
import { registerCapability } from "../registry";

// `list_sandboxes` enumerates the durable sandbox sessions in the caller's
// workspace (rows in `sandbox_sessions`, created by `agent.sandbox.start`), so
// the app's "sandbox detail" page — plus CLI/MCP/agent callers — can show which
// sessions exist, their lifecycle status, and when each was last used, without
// probing every session id individually.
//
// The registry read is followed by a BOUNDED live reconcile: each running|idle
// row is checked against its own driver's sessionStatus (≤25 calls, per-row
// errors tolerated, skipped entirely when no durable driver is configured) so
// the list never reports a session as running/idle that the provider has
// already terminated — a dead session is corrected to `stopped` and the fix
// persisted. When no driver is available the reconcile is a no-op and the raw
// Postgres view is returned, so the capability still works with no sandbox
// backend and consumes no AI tokens — hence `noBillingGate: true`.
//
// Scoped by org + workspace via the capability context (no org/ws in the
// input). Ordered most-recently-used first so the newest activity surfaces at
// the top of the list. `activeOnly` narrows to genuinely-live sessions after
// reconcile.
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
    activeOnly: z
      .boolean()
      .default(false)
      .describe(
        "When true, return only sessions that are running or idle AFTER live " +
          "reconciliation against the driver — sessions the provider has already " +
          "terminated are corrected to stopped and dropped. Default false " +
          "preserves the full non-deleted listing.",
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
          .describe(
            "Opaque durable-session id (sbx_…) — the public id column.",
          ),
        sessionKey: z
          .string()
          .nullable()
          .describe(
            "Caller-supplied reuse key, or null for ephemeral sessions.",
          ),
        label: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Human-friendly name given when the sandbox was warmed, or null when " +
              "unnamed. Sourced from the session metadata.",
          ),
        image: z.enum(["node", "python", "shell", "agent"]),
        status: z.enum(["running", "idle", "stopped", "gone"]),
        driver: z.string().describe("Sandbox driver identifier (e.g. modal)."),
        repos: z
          .array(
            z.object({
              owner: z.string(),
              repo: z.string(),
              branch: z.string().optional(),
            }),
          )
          .optional()
          .describe(
            "Repositories provisioned into this sandbox at start time (from the " +
              "session metadata `repos` key). Omitted when the session was started " +
              "without any repos.",
          ),
        lastUsedAt: z
          .string()
          .nullable()
          .describe("ISO timestamp of the most recent interaction, or null."),
        expiresAt: z
          .string()
          .nullable()
          .describe(
            "ISO soft-expiry timestamp, or null when the session has no expiry.",
          ),
        createdAt: z
          .string()
          .describe("ISO timestamp the session was created."),
        // ── Session lifecycle & work-recovery (spec: sandbox-session-lifecycle) ──
        // All optional so existing callers/parsers are unaffected; the handler
        // always populates them from the registry row.
        recoveryStatus: z
          .string()
          .optional()
          .describe(
            "Work-safety recovery state: none | pending | recovering | recovered | failed.",
          ),
        recoveryBranch: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Branch the reaper pushed uncommitted work to, or null when none.",
          ),
        recoveryCommit: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Commit the reaper captured uncommitted work at, or null when none.",
          ),
        graceDeadlineAt: z
          .string()
          .nullable()
          .optional()
          .describe(
            "ISO reap-eligible instant (last_used_at + grace), or null while a turn is active.",
          ),
        dirty: z
          .boolean()
          .nullable()
          .optional()
          .describe(
            "Last-observed uncommitted-changes state; null when never checked.",
          ),
        flushedAt: z
          .string()
          .nullable()
          .optional()
          .describe(
            "ISO timestamp the reaper terminated the sandbox, or null.",
          ),
        recoveredAt: z
          .string()
          .nullable()
          .optional()
          .describe("ISO timestamp work recovery completed, or null."),
      }),
    ),
  }),
});

export type AgentSandboxListInput = z.output<typeof agentSandboxList.input>;
export type AgentSandboxListOutput = z.output<typeof agentSandboxList.output>;
