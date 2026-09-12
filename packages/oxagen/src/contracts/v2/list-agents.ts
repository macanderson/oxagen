import { z } from "zod";
import { defineTool } from "./_define";
import { agentDefinitionList } from "../agent.definition.list";

/**
 * Appendix E: `list_agents` — absorbs `list_agent_defs`. Blank Does column: the
 * job is unchanged.
 *
 * Every row field carries by reference, including the two that exist to stop an
 * N+1 on the Agents page (`summary` and `toolRefs`) and the `agentType`
 * discriminator whose comment records that ADR-043 retired its `code` value
 * with the execution runtime.
 *
 * One field does not carry, and it is the same one `get_agent` and
 * `update_agent` drop: `latestVersion`. Keeping it here while the write path
 * stopped producing version rows is how a list starts showing a number nothing
 * increments.
 */
const row = agentDefinitionList.output.shape.agents.element.shape;

export const listAgents = defineTool({
  name: "list_agents",
  domain: "agent",
  description:
    "List the agents in the current workspace with their identity, agent key, lifecycle status, deployment posture, summary, and the refs of everything they load.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,

  absorbs: ["list_agent_defs"],
  drops: [
    {
      field: "latestVersion",
      from: "list_agent_defs",
      why: "§6.2 replaces agent_versions with git: a definition's version is the commit it merged at. Carried as `definitionDigest`, which is what a run records as the agent's version and what a reviewer can check against the repo",
    },
  ],

  // Carried unchanged.
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  /**
   * Carried with its reason: read-only introspection consumes no AI tokens, so
   * a zero-credit or dunning-suspended organization can still SEE its
   * automations. Without it the trigger board cannot even load.
   */
  noBillingGate: true,
  // Carried: the source declares `mutates: false`.
  mutates: false,

  input: z.object({
    status: agentDefinitionList.input.shape.status,
  }),

  output: z.object({
    agents: z.array(
      z.object({
        agentId: row.agentId,
        publicId: row.publicId,
        slug: row.slug,
        agentKey: row.agentKey,
        name: row.name,
        description: row.description,
        avatarUrl: row.avatarUrl,
        summary: row.summary,
        agentType: row.agentType,
        status: row.status,
        deploymentStatus: row.deploymentStatus,
        managed: row.managed,
        // Refs only — type + ref, never the per-tool config payloads. Carried
        // with that rule in its own doc comment on the source.
        toolRefs: row.toolRefs,

        /**
         * Replaces `latestVersion` (§6.2). Null before the agent's first
         * Context PR merges — a definition that exists only as an open pull
         * request has no digest at a merged commit yet.
         */
        definitionDigest: z.string().nullable(),
      }),
    ),
  }),
});

export type ListAgentsInput = z.output<typeof listAgents.input>;
export type ListAgentsOutput = z.output<typeof listAgents.output>;
