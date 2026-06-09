import { z } from "zod";
import { registerCapability } from "../registry";

export const agentCodeExecute = registerCapability({
  name: "agent.code.execute",
  domain: "agent",
  description:
    "Execute a code snippet in an isolated sandbox and return stdout, stderr, and exit code. Supports node, python, and shell. Requires SANDBOX_ENABLED=true.",
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
    language: z.enum(["node", "python", "shell"]).describe("Runtime language"),
    code: z.string().min(1).describe("Source code to execute"),
    stdin: z.string().optional().describe("Optional stdin input"),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe("Environment variables to inject"),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(300_000)
      .default(30_000)
      .describe("Execution timeout in milliseconds (1s–5min)"),
    memoryMb: z
      .number()
      .int()
      .min(64)
      .max(2048)
      .default(256)
      .describe("Memory limit in MiB"),
    network: z
      .enum(["allow", "deny"])
      .default("deny")
      .describe("Network access policy for the sandbox"),
  }),
  output: z.object({
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    executionMs: z.number().int(),
    timedOut: z.boolean(),
    oomKilled: z.boolean(),
  }),
});

export type AgentCodeExecuteInput = z.output<typeof agentCodeExecute.input>;
export type AgentCodeExecuteOutput = z.output<typeof agentCodeExecute.output>;
