import { z } from "zod";
import { defineTool } from "./_define";
import { agentGet } from "../agent.get";
import { agentRoleGet } from "../agent.role.get";

/**
 * Appendix E: `get_agent`, "identity, roles, belt, mandates".
 *
 * Appendix E had it absorb `get_agent_def` and `get_agent_role`. ADR-192
 * deleted `get_agent_def` with the definition file it read. The live v1
 * `get_agent` took over its place under this tool's own name: the agent's
 * identity, the runtime it runs on and the toolbelt it carries, its versions,
 * the limits its active version sets, its credentials, the roles on its
 * principal and its host enrollments. An agent is one operator on one runtime
 * with one harness, and each runtime or toolbelt change writes a version, so
 * the versions list is the agent's history.
 *
 * So this descriptor absorbs the live `get_agent` whole and adds the two things
 * Appendix E asks for that it does not return: each role's capability grants,
 * which `get_agent_role` answered one role at a time, and a summary of the
 * mandates the agent holds.
 */
const roleOutput = agentRoleGet.output.shape;

export const getAgent = defineTool({
  name: "get_agent",
  domain: "agent",
  description:
    "Fetch an agent: its identity, the runtime it runs on and the toolbelt it carries, its versions and the limits its active version sets, its credentials and host enrollments, every IAM role its principal holds with the grants each confers, and the mandates it holds.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,

  absorbs: ["get_agent", "get_agent_role"],
  drops: [
    {
      field: "roleName",
      from: "get_agent_role",
      why: "v1 required a role name and answered about that one role, returning `agent_role_not_found` for an unknown one. This tool returns every role the principal holds, with its grants",
    },
    {
      field: "assigned",
      from: "get_agent_role",
      why: "it told 'holds this role' apart from 'this role exists'; every row in `roleGrants` is a role the principal holds, so the flag would read true on every row",
    },
  ],

  /**
   * `get_agent` and `get_agent_role` are both sensitivity "medium" and risk
   * "low". Role grants describe what an agent is permitted to do, which is
   * reconnaissance for anyone deciding what to make it do, so medium stays.
   */
  sensitivity: "medium",
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  defaultEffect: "deny",
  defaultRoles: {
    /**
     * The strict intersection. `get_agent_role` also granted org Compliance and
     * `get_agent` org Member; neither grants both, and the merged tool returns
     * credentials and hosts, so the narrower map carries.
     */
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  /**
   * Carried from both sources: a governance read is never blocked by a zero
   * credit balance. An organization that cannot see what its agents may do
   * cannot decide what to suspend.
   */
  noBillingGate: true,
  mutates: false,

  input: agentGet.input,

  output: agentGet.output.extend({
    /**
     * Each role the principal holds, with the capability grants it confers, so
     * a reviewer sees what a role allows without a call per role.
     */
    roleGrants: z.array(
      z.object({
        roleId: roleOutput.roleId,
        roleName: roleOutput.roleName,
        grants: roleOutput.grants,
      }),
    ),
    /**
     * Summary rows only: mandate id, the consequence tags it authorizes, its
     * window and its status. `list_mandates` owns the full shape, and the
     * remaining authority lives in `tools.mandate_ledger`, which moves between
     * reads. This answers the Agents page question: what may this agent cause,
     * and until when.
     */
    mandates: z.array(
      z.object({
        mandateId: z.string(),
        consequenceTags: z.array(z.string()),
        validFrom: z.string(),
        validTo: z.string(),
        status: z.enum(["active", "expired", "revoked"]),
      }),
    ),
  }),
});

export type GetAgentInput = z.output<typeof getAgent.input>;
export type GetAgentOutput = z.output<typeof getAgent.output>;
