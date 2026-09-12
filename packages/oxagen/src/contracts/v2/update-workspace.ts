import { z } from "zod";
import { defineTool } from "./_define";
import { workspaceSettingsWrite } from "../workspace.settings.write";
import { agentMemoryPolicyWrite } from "../agent.memory_policy.write";
import { workspaceBudgetPolicyWrite } from "../workspace.budget_policy.write";
import { routerPolicySet } from "../router.policy.set";

/**
 * Appendix E: `update_workspace` — "governance mode, retention mode, promotion
 * thresholds, budgets, model routes". Absorbs `update_workspace_settings`,
 * `update_memory_policy`, `update_budget_policy` and `set_routing_policy`.
 *
 * Four contracts that all wrote one row (or one policy hanging off it) become
 * one partial update, because the operator's question is "how is this workspace
 * governed", not "which of four settings tools do I want". Every field stays
 * omit = unchanged, value = set, null = clear, as all four sources were.
 *
 * Three judgment calls a reviewer should check:
 *
 * 1. **Identity fields are carried even though the Does column omits them.**
 *    Appendix E's column lists what this tool newly FOLDS IN; it is not an
 *    exhaustive field list, and `update_workspace_settings` — named in the
 *    absorbs column — is name, slug, description and avatar. Dropping them
 *    would leave no tool anywhere in Appendix E that can rename a workspace.
 *
 * 2. **The nesting is by policy, not flat.** `mode` means three different
 *    things across these sources (budget enforcement, router mode, governance
 *    mode). Flattening would force two of them to be renamed, which breaks the
 *    by-import carry; nesting keeps each field's name and message intact.
 *
 * 3. **`scope` does not carry.** See `drops`.
 */
const budgetInput = workspaceBudgetPolicyWrite.input.shape;
const budgetOutput = workspaceBudgetPolicyWrite.output.shape;
const routingInput = routerPolicySet.input.shape;
const routingOutput = routerPolicySet.output.shape;

export const updateWorkspace = defineTool({
  name: "update_workspace",
  domain: "workspace",
  description:
    "Update a workspace (partial): identity, governance mode, retention mode, promotion thresholds, the memory decay policy, the per-turn dollar budget, and the market-router policy. Only the fields supplied change.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,

  absorbs: [
    "update_workspace_settings",
    "update_memory_policy",
    "update_budget_policy",
    "set_routing_policy",
  ],
  drops: [
    {
      field: "scope",
      from: "set_routing_policy",
      why: "`set_routing_policy` could write the ORG-level routing default from the same call; this tool updates one workspace. Appendix E gives the org-scope routing write to `set_model_route` (Spend and billing — 'tiers and fallbacks'), and Appendix A puts `model_routes` on org.organizations, not wrk.workspaces",
    },
    {
      field: "scope",
      from: "set_routing_policy (output)",
      why: "follows the input: the answer is always this workspace, so echoing a scope discriminator would only ever say 'workspace'",
    },
  ],

  /**
   * Every risk field takes the strictest of the four, and all four strictest
   * values come from `set_routing_policy` — which is right, because turning the
   * market router to `enforce` changes what the platform spends on models, and
   * that is the largest consequence in the merged surface.
   *
   * (`update_workspace_settings`, `update_memory_policy` and
   * `update_budget_policy` were requiresApproval: false / riskLevel
   * medium|low|medium / sensitivity medium.)
   */
  agent: { requiresApproval: true, riskLevel: "high", category: "workspace" },
  sensitivity: "high", // set_routing_policy
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    // Strict intersection of the four: settings/budget/routing allowed
    // workspace Owner (and an unreachable "Admin" that is not a
    // `SystemWorkspaceRole`), `update_memory_policy` allowed Owner alone.
    workspace: { Owner: "allow" },
  },
  /**
   * Carried from `set_routing_policy`, the only source that declared it, and
   * kept rather than dropped as the "strict" reading would suggest. Its reason
   * generalizes to the whole merged surface: governing a workspace is not AI
   * usage. It also closes a trap — with the gate on, an organization that has
   * run out of credit could not turn its budget DOWN, because the call that
   * lowers spend would itself be refused for lack of credit.
   */
  noBillingGate: true,
  mutates: true,

  input: z.object({
    // ---- identity (update_workspace_settings, carried by reference) --------
    name: workspaceSettingsWrite.input.shape.name,
    slug: workspaceSettingsWrite.input.shape.slug,
    description: workspaceSettingsWrite.input.shape.description,
    avatarUrl: workspaceSettingsWrite.input.shape.avatarUrl,

    // ---- governance (new; Appendix A wrk.workspaces) ----------------------
    /**
     * §10.3 step 3 spends this value: `solo` lets the author merge a Context
     * PR, `team` requires a code-owner review, `regulated` requires a named
     * approver from a role and appends to `promotions.jsonl`. It is the
     * strongest single setting on the workspace — it decides whether a human
     * other than the proposer ever looks at what steers the agents.
     */
    governanceMode: z.enum(["solo", "team", "regulated"]).optional(),

    /**
     * Appendix A: "override of the organization's, or null". Explicitly
     * nullable so a workspace can hand the decision back to the org, which an
     * optional-only field could never express. The org's own value is set by
     * `update_org`; §13.1 makes `digest_only` an opt-down that records a
     * completeness gap and lowers the replay grade.
     */
    retentionMode: z
      .enum(["content_exact", "digest_only"])
      .nullable()
      .optional(),

    /**
     * §9.2's thresholds, verbatim: "support across at least N runs and M
     * distinct agents, confidence above a floor". The other two conditions in
     * that sentence — no active contradiction, no open proposal on the lineage
     * — are invariants of the promoter, not customer-tunable numbers, so they
     * are not fields. Appendix A stores this as `wrk.workspaces.promotion_policy`.
     */
    promotionPolicy: z
      .object({
        supportRuns: z.number().int().positive(),
        distinctAgents: z.number().int().positive(),
        confidenceFloor: z.number().min(0).max(1),
      })
      .partial()
      .optional(),

    // ---- memory decay policy (update_memory_policy) -----------------------
    /**
     * Carried whole: `update_memory_policy`'s input is already
     * `memoryPolicySchema.partial()`, so every half-life, threshold and floor
     * keeps its `.describe()` and its bounds. Nested under `memory` because
     * three of its five fields are thresholds and would collide by meaning
     * (not by name) with the promotion and router thresholds beside them.
     */
    memory: agentMemoryPolicyWrite.input.optional(),

    // ---- budget policy (update_budget_policy) -----------------------------
    /**
     * §12.5. Carried field by field so `limitUsd`'s nullable-to-clear encoding
     * and `graceOveragePct`'s 0–10 bound survive, and so does `enforcement`'s
     * distinction between a soft `default` that seeds members and a hard
     * `ceiling` that clamps them.
     */
    budget: z
      .object({
        enabled: budgetInput.enabled,
        limitUsd: budgetInput.limitUsd,
        mode: budgetInput.mode,
        graceOveragePct: budgetInput.graceOveragePct,
        enforcement: budgetInput.enforcement,
      })
      .optional(),

    // ---- market router policy (set_routing_policy, minus `scope`) ---------
    /**
     * §4.5. `mode` is the field that matters: `off` is deterministic routing,
     * `shadow` computes and records the market decision without acting on it,
     * `enforce` routes to the cheapest model clearing the verified-success bar.
     */
    routing: z
      .object({
        mode: routingInput.mode,
        successThreshold: routingInput.successThreshold,
        minSamples: routingInput.minSamples,
        windowDays: routingInput.windowDays,
        escalateOnRejection: routingInput.escalateOnRejection,
      })
      .optional(),
  }),

  output: z.object({
    // The resolved state, not the diff — every source returned it that way, and
    // a partial update's caller cannot otherwise learn what it did not send.
    name: workspaceSettingsWrite.output.shape.name,
    slug: workspaceSettingsWrite.output.shape.slug,
    description: workspaceSettingsWrite.output.shape.description,
    avatarUrl: workspaceSettingsWrite.output.shape.avatarUrl,

    governanceMode: z.enum(["solo", "team", "regulated"]),
    /** Null means "inherit the organization's" — see the input field. */
    retentionMode: z.enum(["content_exact", "digest_only"]).nullable(),
    promotionPolicy: z.object({
      supportRuns: z.number().int().positive(),
      distinctAgents: z.number().int().positive(),
      confidenceFloor: z.number().min(0).max(1),
    }),

    // Carried whole from `update_memory_policy`, whose output is the full
    // (non-partial) memoryPolicySchema.
    memory: agentMemoryPolicyWrite.output,

    budget: z.object({
      enabled: budgetOutput.enabled,
      limitUsd: budgetOutput.limitUsd,
      mode: budgetOutput.mode,
      graceOveragePct: budgetOutput.graceOveragePct,
      enforcement: budgetOutput.enforcement,
    }),

    routing: z.object({
      mode: routingOutput.mode,
      successThreshold: routingOutput.successThreshold,
      minSamples: routingOutput.minSamples,
      windowDays: routingOutput.windowDays,
      escalateOnRejection: routingOutput.escalateOnRejection,
    }),

    /**
     * Appendix A `wrk.workspaces.bundle_version`: "bumped on every publish or
     * grant change". Governance edits made here change what the signed policy
     * bundle says, and an enrolled host holds the previous bundle until it sees
     * a higher version. Returning it is how a caller knows the change has a
     * number to wait for, rather than guessing when the fleet has caught up.
     */
    bundleVersion: z.number().int().nonnegative(),
  }),
});

export type UpdateWorkspaceInput = z.output<typeof updateWorkspace.input>;
export type UpdateWorkspaceOutput = z.output<typeof updateWorkspace.output>;
