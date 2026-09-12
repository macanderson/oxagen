import { z } from "zod";
import { defineTool } from "./_define";
import { agentDefinitionGet } from "../agent.definition.get";
import { agentRoleGet } from "../agent.role.get";

/**
 * Appendix E: `get_agent` — "identity, roles, belt, mandates". Absorbs
 * `get_agent_def` and `get_agent_role`.
 *
 * One read behind the Agents page (§14), which shows an agent's identity, run
 * credential, roles, toolbelt, mandates, budgets and enrollment status in one
 * view. v1 needed a call per section and a round trip per role name.
 *
 * The belt is not a separate field: it is `config.agentTools`, carried whole
 * inside the definition config, because an agent's equipped tools ARE part of
 * its definition (§6.2's TOML `tools` / `deny_tools`) rather than a parallel
 * list that could disagree with it.
 *
 * Mandates are summarized, not reproduced — see the field comment.
 */
const defOutput = agentDefinitionGet.output.shape;
const roleOutput = agentRoleGet.output.shape;

export const getAgent = defineTool({
  name: "get_agent",
  domain: "agent",
  description:
    "Fetch an agent: its identity and agent key, enrollment status and harness, the definition it runs from with its equipped toolbelt, every IAM role its delegated principal holds with that role's capability grants, and the mandates it currently carries.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs", "app"],
  scoped: true,

  absorbs: ["get_agent_def", "get_agent_role"],
  drops: [
    {
      field: "roleName",
      from: "get_agent_role",
      why: "v1 required a role name and answered about that one role, returning `agent_role_not_found` for an unknown one. This tool returns every role the principal holds, so naming one is a filter the caller applies to the result, not an argument — and the unknown-name error moves to `set_agent_role`, the call where a typo would otherwise write nothing and report success",
    },
    {
      field: "assigned",
      from: "get_agent_role",
      why: "it distinguished 'holds this role' from 'this role exists'; every row in `roles` below is an active assignment, so the flag would be true on every row",
    },
    {
      field: "version",
      from: "get_agent_def",
      why: "§6.2 replaces agent_versions with git: the definition's version is the commit it merged at. Carried instead as `definitionDigest` + `definitionCommitSha` (Appendix A iam.principals)",
    },
    {
      field: "isPublished",
      from: "get_agent_def",
      why: "publication is the merge (§4.2), so what is on the context branch is by definition published; an unpublished definition is an open Context PR, which `list_proposals` and the Steering page report",
    },
  ],

  /**
   * `get_agent_def` is sensitivity "low", `get_agent_role` "medium". The
   * stricter wins, and it is the right one for the merged tool: role grants
   * describe exactly what an agent is permitted to do, which is reconnaissance
   * for anyone deciding what to make it do.
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
     * The strict intersection. `get_agent_role` also granted org Compliance;
     * `get_agent_def` did not, and the merged tool returns the definition, so
     * the narrower map carries. If the Audit page needs an agent's governance
     * posture for a Compliance reader, that grant is a deliberate seed rather
     * than something inherited by accident.
     */
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  /**
   * Carried from `get_agent_role`, whose reason generalizes: governance-posture
   * reads must never be blocked by a zero credit balance. An organization that
   * cannot see what its agents are permitted to do cannot decide what to
   * suspend, and suspending is what it does when the bill is the problem.
   */
  noBillingGate: true,
  // Both sources declare `mutates: false`; both are reads.
  mutates: false,

  input: z.object({
    // Carried from `get_agent_def`, the more permissive of the two resolvers
    // (public id, UUID, or slug) — identical in practice to role.get's.
    agentId: agentDefinitionGet.input.shape.agentId,
  }),

  output: z.object({
    // ---- identity (get_agent_def, carried by reference) -------------------
    agentId: defOutput.agentId,
    publicId: defOutput.publicId,
    slug: defOutput.slug,
    // Carried with its `.describe()`: the globally-unique, immutable
    // org_ns.workspace_ns.slug, null only before the namespace backfill.
    agentKey: defOutput.agentKey,
    name: defOutput.name,
    description: defOutput.description,
    avatarUrl: defOutput.avatarUrl,
    summary: defOutput.summary,
    agentType: defOutput.agentType,
    status: defOutput.status,
    deploymentStatus: defOutput.deploymentStatus,
    // True for product-managed built-ins: viewable, never editable.
    managed: defOutput.managed,

    /**
     * §14's Agents page lists enrollment status beside identity, and §6.2 puts
     * both halves on `iam.principals` (Appendix A): the principal's own
     * lifecycle (`unenrolled` until credentials are issued) and the harness the
     * generated definition files were written for. Distinct from `status`
     * above, which is the agent row's draft/active/archived lifecycle.
     */
    enrollment: z.object({
      status: z.enum(["unenrolled", "active", "suspended", "retired"]),
      harness: z.enum([
        "stella",
        "claude-code",
        "codex-cli",
        "openai-agents-sdk",
        "claude-agent-sdk",
        "custom",
      ]),
      harnessVersion: z.string().nullable(),
    }),

    // ---- the definition, and the belt inside it ---------------------------
    /** Appendix A `iam.principals.definition_path` — `.oxagen/agents/<slug>.toml`. */
    definitionPath: z.string().nullable(),
    /** The digest and commit the agent last ran from (§6.2). */
    definitionDigest: z.string().nullable(),
    definitionCommitSha: z.string().nullable(),
    /**
     * Carried whole. `config.agentTools` is the toolbelt; keeping it inside the
     * config rather than lifting it to a sibling field is what stops the belt
     * and the definition from disagreeing.
     */
    config: defOutput.config,

    // ---- roles (get_agent_role, carried per row) --------------------------
    /**
     * Every active assignment on the agent's delegated principal, each with the
     * role's capability grants so a reviewer can see what the role confers
     * without a second call. v1 answered this one role at a time.
     */
    roles: z.array(
      z.object({
        roleId: roleOutput.roleId,
        roleName: roleOutput.roleName,
        // The assignment row itself — provenance, granter, expiry. Carried
        // nullable as v1 declared it, so a role the principal holds through a
        // path that has no assignment row (an org-owner override, §6.3) can
        // still be listed rather than silently omitted.
        assignment: roleOutput.assignment,
        grants: roleOutput.grants,
      }),
    ),

    /**
     * §6.9. Summary rows only — mandate id, the consequence tags it authorizes,
     * its window and its status.
     *
     * The full mandate shape (limits by measure, targets, tool patterns, the
     * approval block, two-person settings) is deliberately NOT duplicated here.
     * Appendix E gives it to `list_mandates` and `grant_mandate`, which land
     * from M2, and §6.9 makes remaining authority a Postgres ledger
     * (`tools.mandate_ledger`) that moves between reads — a second copy of that
     * shape in an identity read is a second thing to keep correct. What this
     * answers is the Agents-page question: what consequences is this agent
     * currently authorized to cause, and until when.
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
