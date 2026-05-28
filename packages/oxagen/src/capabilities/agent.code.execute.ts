import { z } from "zod";
import { registerCapability } from "../registry.js";

export const agentCodeExecute = registerCapability({
  name: "agent.code.execute",
  domain: "agent",
  description: "Run a snippet of Node, Python, or shell in a Docker-isolated sandbox and stream stdout/stderr back to the chat",
  mode: "async",
  surfaces: ["agent"],
  layers: ["schema", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "execution" },
  input: z.object({
    language: z.enum(["node", "python", "shell"]),
    code: z.string().min(1).max(100_000),
    stdin: z.string().optional(),
    env: z.record(z.string()).optional(),
    timeoutMs: z.number().int().positive().max(300_000).default(30_000),
    memoryMb: z.number().int().positive().max(2048).default(512),
    network: z.enum(["allow", "deny"]).default("deny"),
  }),
  output: z.object({
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number().int().nonnegative(),
    timedOut: z.boolean(),
    oomKilled: z.boolean(),
  }),
});

export type AgentCodeExecuteInput = z.infer<typeof agentCodeExecute.input>;
export type AgentCodeExecuteOutput = z.infer<typeof agentCodeExecute.output>;
