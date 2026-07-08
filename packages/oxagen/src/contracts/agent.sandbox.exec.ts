import { z } from "zod";
import { registerCapability } from "../registry";
import { sanitizeSandboxEnv } from "./agent.code.execute";

// `agent.sandbox.exec` runs a shell command inside an existing durable sandbox
// (from `agent.sandbox.start`). The filesystem and processes are SHARED across
// calls — a clone in one exec is visible to a build in the next. If the backing
// sandbox was reaped while idle, the handler restores it from the last snapshot
// and retries transparently (`restored: true`).

export const agentSandboxExec = registerCapability({
  name: "run_sandbox_command",
  aliases: ["agent.sandbox.exec"],
  domain: "agent",
  description:
    "Run a shell command inside a durable sandbox session. Filesystem/process state persists across calls. Returns stdout, stderr, exit code.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "execution" },
  sensitivity: "high",
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
    command: z
      .string()
      .min(1)
      .max(100_000)
      .describe("Shell command line, run via `sh -c` in the session workspace."),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(600_000)
      .default(120_000)
      .describe("Execution timeout in milliseconds (1s–10min)."),
    env: z
      .record(z.string(), z.string())
      .optional()
      .transform(sanitizeSandboxEnv)
      .describe(
        "Environment variables for this command. Reserved sandbox/host names and " +
          "prefixes (PATH, LD_*, MODAL_*, DATABASE_*, …) are stripped; capped at 32 keys / 8KB.",
      ),
    stdin: z.string().optional().describe("Optional stdin input."),
  }),
  output: z.object({
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    executionMs: z.number().int(),
    timedOut: z.boolean(),
    restored: z
      .boolean()
      .describe("True when the session had been reaped and was restored from a snapshot before running."),
  }),
});

export type AgentSandboxExecInput = z.output<typeof agentSandboxExec.input>;
export type AgentSandboxExecOutput = z.output<typeof agentSandboxExec.output>;
