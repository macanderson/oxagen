import { z } from "zod";
import { registerCapability } from "../registry";

export const agentRepoEdit = registerCapability({
  name: "agent.repo.edit",
  domain: "agent",
  description:
    "Use the coding agent to edit files in a connected GitHub repository and open a pull request with the changes.",
  mode: "sync",
  surfaces: ["api", "agent", "mcp"],
  layers: ["api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "high", category: "vcs" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    owner: z.string().describe("GitHub organisation or user that owns the repository"),
    repo: z.string().describe("Repository name (without the owner prefix)"),
    instruction: z
      .string()
      .min(10, "Instruction must be at least 10 characters")
      .describe("Natural-language coding instruction for the agent (min 10 chars)"),
    baseBranch: z
      .string()
      .optional()
      .describe("Branch to base the changes on (defaults to 'main' when omitted)"),
    branchName: z
      .string()
      .optional()
      .describe("Branch name to push the agent's changes to (auto-generated when omitted)"),
    model: z
      .string()
      .optional()
      .describe("Vercel AI Gateway model id, e.g. 'anthropic/claude-opus-4-8'"),
    maxSteps: z
      .number()
      .int()
      .min(1)
      .max(40)
      .optional()
      .default(12)
      .describe("Maximum coding-loop steps the agent may execute (1–40, default 12)"),
  }),
  output: z.object({
    prNumber: z.number().describe("Pull request number opened by the agent"),
    prUrl: z.string().describe("HTML URL of the pull request"),
    branch: z.string().describe("Branch the agent's changes were pushed to"),
    changedFiles: z
      .array(z.string())
      .describe("Relative paths of every file changed by the agent"),
    summary: z.string().describe("Final response text from the coding agent"),
  }),
});

export type AgentRepoEditInput = z.output<typeof agentRepoEdit.input>;
export type AgentRepoEditOutput = z.output<typeof agentRepoEdit.output>;
