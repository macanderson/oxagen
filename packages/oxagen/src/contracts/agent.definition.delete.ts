import { z } from "zod";
import { registerCapability } from "../registry";

// Soft-delete an agent identity. Per Agent RBAC Phase 1
// (docs/specs/agent-rbac/spec.md §2.1): an agent's delegated iam.principals
// row is soft-deleted TOGETHER with the agent — the identity and its
// principal share one lifecycle. Hard deletes are prohibited on org-scoped
// tables; the row (and its principal) is retained for audit.
export const agentDefinitionDelete = registerCapability({
  name: "delete_agent_def",
  domain: "agent",
  description:
    "Soft-delete an agent definition and its delegated IAM principal together — the row is retained for audit but the agent stops appearing in every list and can no longer run",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "mutation" },
  sensitivity: "destructive",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    agentId: z.string().describe("Agent public id (agt_…) or UUID"),
  }),
  output: z.object({
    agentId: z.string(),
    deleted: z.boolean(),
  }),
});

export type AgentDefinitionDeleteInput = z.output<
  typeof agentDefinitionDelete.input
>;
export type AgentDefinitionDeleteOutput = z.output<
  typeof agentDefinitionDelete.output
>;
