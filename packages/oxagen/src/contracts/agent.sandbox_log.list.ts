import { z } from "zod";
import { registerCapability } from "../registry";

// `list_sandbox_logs` returns the captured stdout/stderr output of a durable
// sandbox session's commands (spec: sandbox-session-lifecycle §7). The sandbox
// inspector's log console reads this; the `level` filter drives its Debug toggle
// ('normal' program output vs 'debug' command echoes/timings/plumbing).
//
// Read-only, no billing gate — mirrors `list_sandbox_files`. Logs live in
// ClickHouse (append-only runtime telemetry, 14-day TTL) and OUTLIVE the session
// row, so a recently-flushed session's output is still inspectable. Tenant
// scoping is enforced by the org/workspace filter in the ClickHouse query.
export const agentSandboxLogsList = registerCapability({
  name: "list_sandbox_logs",
  domain: "agent",
  description:
    "List captured stdout/stderr/command output for a durable sandbox session.",
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
    sessionId: z
      .string()
      .min(1)
      .describe("Durable-session id (sbx_…) returned by agent.sandbox.start."),
    level: z
      .enum(["normal", "debug"])
      .optional()
      .describe(
        "Verbosity filter: 'normal' returns only program output (debug toggle OFF); omit for all lines.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .default(500)
      .describe("Max lines returned (the newest N, in chronological order)."),
    sinceMs: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Epoch-ms floor on the line timestamp; defaults to 24h ago."),
  }),
  output: z.object({
    lines: z.array(
      z.object({
        ts: z.string(),
        stream: z.enum(["stdout", "stderr", "system"]),
        level: z.enum(["normal", "debug"]),
        command: z.string(),
        seq: z.number().int(),
        line: z.string(),
        exitCode: z.number().int().nullable(),
        durationMs: z.number().int().nullable(),
      }),
    ),
  }),
});

export type AgentSandboxLogsListInput = z.output<
  typeof agentSandboxLogsList.input
>;
export type AgentSandboxLogsListOutput = z.output<
  typeof agentSandboxLogsList.output
>;
