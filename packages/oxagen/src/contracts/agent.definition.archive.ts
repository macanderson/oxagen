import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * agent.definition.archive — retire an agent identity: sets status='archived'
 * (soft-delete) on the agent row and soft-deletes its IAM principal
 * (iam.principals kind='agent') in the same transaction, so a retired agent
 * disappears from every IAM surface (role assignments, effective-permission
 * resolution) together with its identity row. Irreversible — an archived
 * agent is never reactivated (docs/specs/agent-rbac/spec.md §3.1/§2.1).
 */
export const agentDefinitionArchive = registerCapability({
  name: "archive_agent_def",
  domain: "agent",
  description:
    "Archive (soft-delete) an agent definition and soft-delete its IAM agent principal together — irreversible",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "mutation" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({
    agentId: z.string().describe("Agent public id (agt_…) or UUID"),
  }),
  output: z.object({
    agentId: z.string(),
    archived: z.literal(true),
  }),
});

export type AgentDefinitionArchiveInput = z.output<
  typeof agentDefinitionArchive.input
>;
export type AgentDefinitionArchiveOutput = z.output<
  typeof agentDefinitionArchive.output
>;
