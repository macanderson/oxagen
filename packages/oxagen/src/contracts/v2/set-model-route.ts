import { z } from "zod";
import { defineTool } from "./_define";
import { workspaceModelSettingsWrite } from "../workspace.model_settings.write";
import { workspaceModelSettingsRead } from "../workspace.model_settings.read";
import { routerDecisionPreview } from "../router.decision.preview";
import { routerPolicyGet } from "../router.policy.get";

/**
 * Appendix E: `set_model_route` — "tiers and fallbacks". Absorbs
 * `update_model_settings`, `get_model_settings`, `preview_routing_decision` and
 * `get_routing_policy`.
 *
 * §4.5 is the job: every model call resolves a funding source, then the tier
 * the caller asked for, then the provider route for that tier. Funding is its
 * own tool (`set_funding_source`, new in Appendix E); tiers and routes are this
 * one. Rule 2 — "An organization may pin a concrete id, choose a different
 * vendor per tier, or set a fallback route for when the primary returns a
 * provider error" — is what `routes` exists for, and is the "fallbacks" half of
 * the Does column. No absorbed contract had a route table: v1 could set one
 * default text model and nothing else.
 *
 * Two decisions worth checking:
 *
 * 1. **The preview becomes a dry run of THIS write, not a free-standing
 *    inspector.** `preview_routing_decision` took a prompt plus per-call policy
 *    overrides and answered "what would the router do?". Those overrides are
 *    the very fields being persisted here, so they carry as the policy itself
 *    and `dryRun` changes their lifetime rather than their meaning: with
 *    `dryRun: true` the tool returns the decision the submitted policy WOULD
 *    produce and writes nothing. The alternative — a separate inspector tool —
 *    is what Appendix E deleted.
 *
 * 2. **Two tier vocabularies coexist, on purpose.** §4.5's tiers (complex,
 *    light, embed, rerank) govern Oxagen's own work, and rule 5 is explicit
 *    that customer agents are unaffected by them. `defaultTextTier` (fast,
 *    balanced, precise) is the workspace default handed to a customer's agents.
 *    They are different tables for different callers, so both carry rather than
 *    one being coerced into the other.
 */

/**
 * Carried by import: the write scope is the read's provenance minus `default`.
 * You can read that a policy came from the built-in default; you cannot write
 * to it.
 */
const routeScope = routerPolicyGet.output.shape.source.exclude(["default"]);

/** §4.5's tier table — the tiers Oxagen's own model layer resolves. */
const modelTier = z.enum(["complex", "light", "embed", "rerank"]);

const routeEntry = z.object({
  tier: modelTier,
  /**
   * §4.5 rule 1: configure the alias, record the concrete model. A rolling
   * alias (`z-ai/glm-latest`) keeps "latest" current without a deploy; a
   * concrete id pins it. Both are valid here, and the frame records whichever
   * the provider actually returned.
   */
  route: z.string().min(1),
  /**
   * §4.5 rule 2: the route used when the primary returns a provider error.
   * Null means no fallback — the call fails rather than silently re-routing,
   * which matters because every fallback is recorded as a frame.
   */
  fallback: z.string().min(1).nullable(),
});

export const setModelRoute = defineTool({
  name: "set_model_route",
  domain: "router",
  description:
    "Set the model routes for a scope: the provider route and fallback route per tier (§4.5), the workspace's default text tier and model, and the verified-outcome market-router policy (mode, success threshold, minimum samples, window, tier escalation). With dryRun, returns the decision the submitted policy would produce for a sample prompt and writes nothing.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,

  absorbs: [
    "update_model_settings",
    "get_model_settings",
    "preview_routing_decision",
    "get_routing_policy",
  ],
  renames: [
    {
      from: "prompt",
      source: "preview_routing_decision",
      to: "samplePrompt",
      why: "carried by import from the same shape, but the field's context changed with the tool's. On the v1 inspector the prompt WAS the subject: the whole call existed to route it. Here the subject is the route table, and every other input field is persisted policy — a bare `prompt` sitting beside `routes` and `mode` would read as another thing being written. `samplePrompt` marks it as the one input that is not stored: the throwaway workload the dry run evaluates the submitted policy against, read only when `dryRun` is set",
    },
  ],
  drops: [
    {
      field: "fileCount",
      from: "preview_routing_decision",
      why: "a structural signal fed to the deterministic fallback's task-class bucketing. The dry run here evaluates the policy being written against a prompt, not an arbitrary synthesized workload; a real run derives these signals from its own frames",
    },
    {
      field: "crossPackage",
      from: "preview_routing_decision",
      why: "same as fileCount — a synthesized structural signal with no counterpart in a persisted route",
    },
    {
      field: "taskClass",
      from: "preview_routing_decision",
      why: "overriding the derived class inspects one bucket of the router's learned curve; that read is get_spend's `byTaskClassModel` (Appendix E folds list_routing_stats there), not a knob on a write",
    },
  ],

  /**
   * Strictest of the four. `update_model_settings` is sensitivity medium and
   * grants only the governance roles; the three router reads are sensitivity
   * low and grant workspace Member and Viewer, because reading what the router
   * learned is not changing where the money goes. Those two do not carry to a
   * write. Approval is false on all four sources and stays false.
   *
   * riskLevel stays `low` as every source declares it. It is the one value here
   * a reviewer might argue up: this tool now repoints the org's route table,
   * which §4.5 makes the resolution path for every model call. Nothing in the
   * spec asks for more, so the carry is left alone rather than invented up.
   */
  agent: { requiresApproval: false, riskLevel: "low", category: "workspace" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  /**
   * Carried from the three router contracts. It matters more here than on a
   * read: re-routing to a cheaper tier is how an org that is over its ceiling
   * gets back under it, so gating this call on balance would lock the door
   * from the inside.
   */
  noBillingGate: true,
  // Writes the workspace model settings row and the scope's routing policy.
  // `dryRun: true` writes nothing, but `mutates` describes the capability, not
  // one call's arguments — the engine cannot dispatch on an argument value.
  mutates: true,

  input: z.object({
    /**
     * Which scope the write targets. §4.5 rule 2 makes routes an organization
     * setting; the workspace row overrides it, and `get_routing_policy`'s
     * provenance already reported which of the two supplied the live value.
     */
    scope: routeScope.default("workspace"),

    /**
     * §4.5's route table. Omit to leave it unchanged; entries are upserted by
     * tier, so sending one entry changes one tier.
     */
    routes: z.array(routeEntry).max(4).optional(),

    // Carried nullable-optional: omit = no change, null = clear the setting,
    // string = set. The three-state shape is why these carry by reference
    // rather than being re-declared as plain optionals.
    defaultTextTier: workspaceModelSettingsWrite.input.shape.defaultTextTier,
    defaultTextModel: workspaceModelSettingsWrite.input.shape.defaultTextModel,

    /**
     * The market-router policy, carried by import from
     * `preview_routing_decision`'s override block — which is where the bounded
     * versions of these fields live (`successThreshold` is 0–1, `windowDays` is
     * a positive integer). In v1 they were per-call overrides for a dry run;
     * here the same shapes are the persisted policy. Each is optional: omit to
     * leave that tunable unchanged.
     */
    mode: routerDecisionPreview.input.shape.mode,
    successThreshold: routerDecisionPreview.input.shape.successThreshold,
    minSamples: routerDecisionPreview.input.shape.minSamples,
    windowDays: routerDecisionPreview.input.shape.windowDays,
    escalateOnRejection: routerDecisionPreview.input.shape.escalateOnRejection,

    /**
     * New: evaluate and return, write nothing. This is what survives of
     * `preview_routing_decision` as a tool — the inspector folded into the
     * setter so "what would this change do?" and "do it" are one contract and
     * cannot drift apart.
     */
    dryRun: z.boolean().default(false),
    /**
     * Carried from preview: the prompt the dry run routes. Required when
     * `dryRun` is set — a dry run with nothing to route has no decision to
     * report.
     */
    samplePrompt: routerDecisionPreview.input.shape.prompt.optional(),
  })
    /**
     * The comment above is a requirement, so it is enforced rather than
     * asserted: `dryRun: true` with no prompt to route validates happily and
     * then has no decision to return, so the caller who asked "what would this
     * change do?" gets a successful `decision: null` and no way to tell that
     * from "the policy produced no decision". Rejecting at the boundary is the
     * only place the two are still distinguishable.
     */
    .superRefine((v, ctx) => {
      if (v.dryRun && v.samplePrompt === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["samplePrompt"],
          message: "samplePrompt is required when dryRun is true",
        });
      }
    }),

  output: z.object({
    scope: routeScope,
    /** The full route table after the write (or as it would stand, under dryRun). */
    routes: z.array(routeEntry),

    // Carried: the resolved settings, the same pair get_model_settings returned.
    defaultTextTier: workspaceModelSettingsRead.output.shape.defaultTextTier,
    defaultTextModel: workspaceModelSettingsRead.output.shape.defaultTextModel,

    /**
     * The effective policy after the write, carried whole from the preview's
     * snapshot, plus the provenance `get_routing_policy` returned. Provenance
     * survives because a workspace write that is still shadowed by an org row
     * has to be visible as such.
     */
    policy: routerDecisionPreview.output.shape.policySnapshot,
    policySource: routerPolicyGet.output.shape.source,

    /**
     * Present only when `dryRun` and `samplePrompt` were given. Carried whole
     * from `preview_routing_decision`: the model it would pick, why, whether
     * the pick came from a real market clearing or the deterministic fallback,
     * and the ranked candidates it beat — the audit trail that makes the
     * decision checkable instead of asserted.
     */
    decision: z
      .object({
        tier: routerDecisionPreview.output.shape.tier,
        model: routerDecisionPreview.output.shape.model,
        rationale: routerDecisionPreview.output.shape.rationale,
        source: routerDecisionPreview.output.shape.source,
        taskClass: routerDecisionPreview.output.shape.taskClass,
        candidates: routerDecisionPreview.output.shape.candidates,
      })
      .nullable(),
  }),
});

export type SetModelRouteInput = z.output<typeof setModelRoute.input>;
export type SetModelRouteOutput = z.output<typeof setModelRoute.output>;
