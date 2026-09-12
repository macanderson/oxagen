import { z } from "zod";
import { defineTool } from "./_define";
import { agentDefinitionUpdate } from "../agent.definition.update";
import { agentDefinitionRevise } from "../agent.definition.revise";
import { agentDeploy } from "../agent.deploy";
import { contextPrSchema } from "./register-agent";

/**
 * Appendix E: `update_agent` — "a Context PR changing the definition; identity
 * and belt update on merge". Absorbs `update_agent_def`, `revise_agent_def`,
 * `publish_agent_def` and `deploy_agent`.
 *
 * Same shape as `register_agent` and the same reason (§6.2): the definition is
 * a file, so changing it is a pull request, and the identity half catches up on
 * merge. Two of the four absorbed contracts therefore lose their job entirely:
 *
 *  - **`publish_agent_def` has nothing left to do.** v1 published by flipping
 *    `isPublished` on a version row and computing a checksum over its config.
 *    In v2 the merge is the publication — §4.2's rule is that "git is the source
 *    of truth for exactly one thing: what is published and active." A second
 *    publish step after a merge could only ever disagree with git.
 *  - **`deploy_agent` survives, but not through the PR.** See the field comment
 *    on `deploymentStatus`; it is the one input here that does not go to git.
 *
 * `revise_agent_def` folds in the way `suggest_agent_def` folded into
 * `register_agent`: supply `config` to say exactly what the definition should
 * become, or `prompt` to describe the change and have the model write it.
 */
const updateInput = agentDefinitionUpdate.input.shape;
const reviseOutput = agentDefinitionRevise.output.shape;

export const updateAgentInputObject = z.object({
  // Carried with its `.describe()` — public id, UUID, or slug.
  agentId: updateInput.agentId,

  // ---- identity-row edits (update_agent_def, carried by reference) --------
  name: updateInput.name,
  description: updateInput.description,
  // Carried with its reason intact: the Workbench "code features" toggle is
  // persisted as agentType, so editing an existing agent must be able to flip it.
  agentType: updateInput.agentType,
  // Omit = unchanged, value = set, null = clear.
  avatarUrl: updateInput.avatarUrl,

  /**
   * The new versioned body. Carried from `update_agent_def`, made optional
   * because `prompt` is the other way to produce one and because a rename
   * should not require restating the whole config.
   */
  config: updateInput.config.optional(),

  /**
   * The model-driven path, carried from `revise_agent_def` with its 10–4000
   * bounds and its example ("give it read access to the billing ontology and
   * equip the github MCP server"). The agent's slug is never changed by a
   * revision — ADR-024 makes the agent key immutable — so a revision can only
   * ever edit the file, never rename it.
   */
  prompt: agentDefinitionRevise.input.shape.prompt.optional(),

  /**
   * Carried from `deploy_agent`, and the one field here that takes effect
   * IMMEDIATELY in Postgres rather than on merge.
   *
   * That asymmetry is deliberate. §6.2 splits the agent in two and puts in
   * Postgres "the things that must be revocable in one second"; deployment
   * posture is one of them, because making an agent's triggers dormant is how
   * an operator stops it. A round trip through review and merge cannot be part
   * of that path. The definition is what the agent IS and goes to git; the
   * posture is whether it is running and stays in the control plane.
   *
   * The enum carries as-is: `retire_agent` is how an agent leaves for good
   * (§6.2 — the principal is retired, never deleted), and `unenrolled` is a
   * credential state the operator does not set by hand.
   */
  deploymentStatus: agentDeploy.input.shape.deploymentStatus.optional(),
});

const updateAgentInput = updateAgentInputObject.superRefine((value, ctx) => {
  const changed =
    value.name !== undefined ||
    value.description !== undefined ||
    value.agentType !== undefined ||
    value.avatarUrl !== undefined ||
    value.config !== undefined ||
    value.prompt !== undefined ||
    value.deploymentStatus !== undefined;
  if (!changed) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "supply at least one change — an update with nothing to change would open an empty Context PR on the customer's main repo",
    });
  }
});

export const updateAgent = defineTool({
  name: "update_agent",
  domain: "agent",
  description:
    "Change an agent by opening a Context PR on the workspace's main repo that edits .oxagen/agents/<slug>.toml and regenerates its harness files. Supply a config, or a plain-language prompt for the model to write the revision. Identity, roles and toolbelt update when the PR merges (§6.2). Deployment posture, if supplied, applies immediately.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs", "app"],
  scoped: true,

  absorbs: [
    "update_agent_def",
    "revise_agent_def",
    "publish_agent_def",
    "deploy_agent",
  ],
  drops: [
    {
      field: "version",
      from: "update_agent_def",
      why: "§6.2 replaces agent_versions with git: a definition's version is the commit it merged at, recorded as `definition_digest`. `contextPr.headSha` + `definitionDigest` carry the identity that number carried",
    },
    {
      field: "isPublished",
      from: "update_agent_def",
      why: "publication is the merge (§4.2: git is the source of truth for what is published and active), so an unpublished-version flag has no state to describe. `contextPr.state` is the honest replacement",
    },
    {
      field: "isPublished",
      from: "revise_agent_def",
      why: "same; revise's field was documented as 'always false' because publish was a separate step, and that step is gone",
    },
    {
      field: "version",
      from: "publish_agent_def",
      why: "there is no version to name: publishing is merging the pull request, and the PR already identifies exactly one commit",
    },
    {
      field: "checksum",
      from: "publish_agent_def",
      why: "a SHA-256 over the canonical config, computed at publish. Superseded by `definitionDigest`, the digest of the file at the merged commit (§6.2), which is the fingerprint runs actually record",
    },
    {
      field: "activeVersionId",
      from: "publish_agent_def",
      why: "the active version is whatever the definition file says at the workspace's context branch; a row id pointing at a version table that no longer exists cannot say that",
    },
  ],

  // All four sources agree: medium sensitivity, medium risk, no approval,
  // category "mutation", identical default roles. Nothing to resolve.
  agent: { requiresApproval: false, riskLevel: "medium", category: "mutation" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  mutates: true,

  input: updateAgentInput,

  output: z.object({
    agentId: agentDefinitionRevise.output.shape.agentId,

    /**
     * Null when the call only changed `deploymentStatus` — that path never
     * touches the definition, so it opens no pull request. Any other change
     * produces one.
     */
    contextPr: contextPrSchema.nullable(),

    // §6.2, as in register_agent: path plus digest at the PR's head commit.
    definitionPath: z.string().nullable(),
    definitionDigest: z.string().nullable(),
    /** Regenerated beside the canonical file; empty for Stella. */
    generatedFiles: z.array(z.string()),

    // Carried from `deploy_agent`: the posture in force right now.
    deploymentStatus: agentDeploy.output.shape.deploymentStatus,

    // ---- the revision explanation (revise_agent_def), carried whole -------
    /** Null when the caller supplied `config` rather than a `prompt`. */
    rationale: reviseOutput.rationale.nullable(),
    // The diff line the UI shows: short bullets of what changed versus the
    // prior version. Carried because the PR body is built from it.
    changeSummary: reviseOutput.changeSummary,
    warnings: reviseOutput.warnings,
    // Connect-first: tools the revised agent SHOULD have but the workspace does
    // not offer yet. Never equipped automatically — carried with that rule in
    // its own `.describe()`.
    recommendations: reviseOutput.recommendations,
  }),
});

export type UpdateAgentInput = z.output<typeof updateAgent.input>;
export type UpdateAgentOutput = z.output<typeof updateAgent.output>;
