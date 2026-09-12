import { z } from "zod";
import { defineTool } from "./_define";
import {
  billingUsageBreakdown,
  billingUsageBreakdownFields,
} from "../billing.usage.breakdown";
import { routerStatsList } from "../router.stats.list";
import { repoMetrics } from "../repo.metrics";

/**
 * Appendix E: `get_spend` — "rollups at any level with basis". Absorbs
 * `get_usage_breakdown`, `list_routing_stats` and `get_repo_metrics`.
 *
 * §12.7 is the shape of this tool: every cost record hangs on a frame, every
 * frame knows its step, turn, run, agent, operator, workspace and organization,
 * so attribution is one rollup walked along that hierarchy. v1 had a single
 * org-wide breakdown; v2 takes the level as an argument.
 *
 * Three judgment calls a reviewer should check:
 *
 * 1. **`basis` is the point of the tool's name.** §12.9: "Every number carries
 *    its basis." No absorbed contract had the field — the v1 breakdown returned
 *    costMicros with no way to tell a gateway-observed dollar from a
 *    client-attested one. It is new here, with A.7 `cost.run_totals.cost_basis`
 *    as its domain.
 *
 * 2. **`list_routing_stats` carries its row, not its verdict.** The observed
 *    (task class, model) aggregate — verified rate against average cost — is
 *    spend evidence and is the input to §12.8's "Wrong tier" finding, so it
 *    carries. The derived "cheapest model clearing the bar" summary is a
 *    routing decision, and routing decisions belong to `set_model_route`.
 *
 * 3. **`get_repo_metrics` carries its dimension, not its panel.** §12.7 lists
 *    repository among the keys every level adds, so the repo filter and the
 *    per-repo rollup carry. Sync health — entity counts, last error, next sync
 *    — is the Ontology → Repositories page (§14) and does not.
 */

// Carried by reference: totals keep "cachedTokens is a subset of inputTokens"
// and the cache-write premium note, which are the parts most easily lost.
const totals = billingUsageBreakdown.output.shape.totals;
const breakdownRow = billingUsageBreakdown.output.shape.byModel.element;

/**
 * New in v2. A.7 `cost.run_totals.cost_basis`: `mixed` exists because a rollup
 * spans many frames, and a window that mixes proxied and attested runs must say
 * so rather than report the flattering half. §12.4: client-attested frames
 * match reconciliation only at key-day level and are labeled as such.
 */
const costBasis = z.enum([
  "gateway_observed",
  "client_attested",
  "mixed",
  "estimated",
]);

/**
 * The rollup levels of §12.7's hierarchy. `step` and `frame` are absent on
 * purpose: a step's cost is the frame's, and a frame is read through the Run
 * player, not through a rollup.
 */
const spendLevel = z.enum([
  "org",
  "workspace",
  "operator",
  "agent",
  "run",
  "turn",
]);

/**
 * Exported for the same reason `billingUsageBreakdownFields` is: the window
 * rules below are cross-field `.refine()`s, and a refined input is a ZodEffects
 * with no `.shape` for a surface to destructure.
 */
export const getSpendFields = {
  // Carried by reference — the ISO-8601 + offset requirement and the
  // inclusive/exclusive convention stay attached to the fields.
  start: billingUsageBreakdownFields.start,
  end: billingUsageBreakdownFields.end,
  workspaceId: billingUsageBreakdownFields.workspaceId,

  // New in v2: which level of §12.7's hierarchy to roll up to.
  level: spendLevel.default("org"),
  /**
   * The id of the thing at `level` — an operator or agent principal id, a run
   * or turn graph id. Omitted for `org`, and for `workspace` when `workspaceId`
   * already names it.
   */
  scopeId: z.string().optional(),

  // Carried from get_repo_metrics: §12.7 makes repository an attribution key at
  // every level, so it is a filter here rather than its own capability.
  repoId: repoMetrics.input.shape.repoId.optional(),
} as const;

const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

export const getSpend = defineTool({
  name: "get_spend",
  domain: "cost",
  description:
    "Roll up spend at any level of the attribution hierarchy — organization, workspace, operator, agent, run, or turn — over a bounded window, broken down by model, surface, tool, principal, provider key, repository and task, with the daily series, cache economics, proven-versus-unproven split, and the cost basis behind every number (§12.7, §12.9).",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,

  absorbs: ["get_usage_breakdown", "list_routing_stats", "get_repo_metrics"],
  drops: [
    {
      field: "byUser",
      from: "get_usage_breakdown",
      why: "§12.7's hierarchy has no seat level — a human's spend is the operator's, and `byPrincipal` already carries it keyed on the principal spine; §3 makes operator the word the product uses",
    },
    {
      field: "summary",
      from: "list_routing_stats",
      why: "the cheapest-model-clearing-the-bar derivation is a routing decision, not a rollup — it moves to set_model_route, which Appendix E gives 'tiers and fallbacks'",
    },
    {
      field: "window",
      from: "list_routing_stats",
      why: "this tool has one window (start/end, carried from get_usage_breakdown); echoing a second policy-derived window would let one response report two different periods",
    },
    {
      field: "taskClass",
      from: "list_routing_stats",
      why: "§12.7 fixes the attribution keys (model, provider, provider key, funding source, tool, repository, task reference); task class is a router-internal bucket and is not one of them — it survives as a row key inside byTaskClassModel, not as a filter",
    },
    {
      field: "windowDays",
      from: "list_routing_stats",
      why: "follows `window` — the routing rows are computed over this tool's start/end, not over the policy's trailing window",
    },
    {
      field: "minSamples",
      from: "list_routing_stats",
      why: "an eligibility threshold for routing, not a rollup filter; it belongs with the policy set by set_model_route",
    },
    {
      field: "status",
      from: "get_repo_metrics",
      why: "repo connection health — Ontology → Repositories (§14)",
    },
    {
      field: "entityCount",
      from: "get_repo_metrics",
      why: "ingestion volume, not spend — Ontology → Repositories",
    },
    {
      field: "entityCountByType",
      from: "get_repo_metrics",
      why: "ingestion volume — Ontology → Repositories",
    },
    {
      field: "lastSyncAt",
      from: "get_repo_metrics",
      why: "sync health — Ontology → Repositories ('last indexed commit, event health', §14)",
    },
    {
      field: "lastSyncDurationMs",
      from: "get_repo_metrics",
      why: "sync health — Ontology → Repositories",
    },
    {
      field: "lastErrorAt",
      from: "get_repo_metrics",
      why: "sync health — Ontology → Repositories",
    },
    {
      field: "errorMessage",
      from: "get_repo_metrics",
      why: "sync health — Ontology → Repositories",
    },
    {
      field: "syncIntervalSeconds",
      from: "get_repo_metrics",
      why: "§11 fixes repo sync to webhook-driven with manual re-sync; there is no per-repo interval left to report",
    },
    {
      field: "estimatedNextSyncAt",
      from: "get_repo_metrics",
      why: "follows syncIntervalSeconds — polling is gone",
    },
  ],

  // All three sources agree: no approval, low risk, read-only, sensitivity low.
  agent: { requiresApproval: false, riskLevel: "low", category: "billing" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    /**
     * Strictest of the three, with one deliberate exception. The org sets
     * intersect at {Owner, Admin}; Billing is kept because get_usage_breakdown
     * — the only money source of the three — grants it, and reading spend is
     * the Billing role's entire job (§14 Billing). list_routing_stats has no
     * Billing grant because a router read is not a money read; its silence is
     * not a denial.
     *
     * At workspace scope the strictest source (get_usage_breakdown) grants
     * nothing at all, but §14 puts Spend among the seven workspace-scope pages,
     * so an empty map would make the page unreachable. The strictest workable
     * set is taken: Owner alone. Member and Viewer, which list_routing_stats
     * granted for a router read, do not carry to a money read.
     */
    org: { Owner: "allow", Admin: "allow", Billing: "allow" },
    workspace: { Owner: "allow" },
  },
  /**
   * Carried from get_usage_breakdown and list_routing_stats: a read of your own
   * spend must never be charged or gated on balance, or an org that ran out of
   * credit could no longer see that it had. get_repo_metrics does not declare
   * the flag, but this is a property of the read rather than a permission — the
   * looser value is the correct one, and is the reason the field exists.
   */
  noBillingGate: true,
  // All three handlers read only: billing.usage.breakdown and repo.metrics are
  // SELECTs, and router.stats.list reads stats then derives in memory.
  mutates: false,

  input: z
    .object(getSpendFields)
    // The two window rules cannot ride the field carry — they live on
    // get_usage_breakdown's ZodEffects, which has no shape. The messages are
    // reproduced verbatim so the API error a client already handles is unchanged.
    .refine((v) => new Date(v.end).getTime() > new Date(v.start).getTime(), {
      message: "end must be after start",
      path: ["end"],
    })
    .refine(
      (v) =>
        new Date(v.end).getTime() - new Date(v.start).getTime() <= MAX_RANGE_MS,
      { message: "range must not exceed 366 days", path: ["end"] },
    )
    // New: the levels below workspace name a specific thing, and a rollup for
    // "some agent" is not a number anyone can act on.
    .refine(
      (v) =>
        v.level === "org" || v.level === "workspace" || v.scopeId !== undefined,
      {
        message:
          "scopeId is required for level 'operator', 'agent', 'run' and 'turn'",
        path: ["scopeId"],
      },
    ),

  output: z.object({
    level: spendLevel,
    scopeId: z.string().nullable(),
    range: billingUsageBreakdown.output.shape.range,

    /**
     * §12.9: every number that is money shows its basis. This is the basis of
     * the whole rollup; a window mixing proxied and attested runs reports
     * `mixed` rather than the flattering half.
     */
    basis: costBasis,

    totals,
    cacheSavingsMicros: billingUsageBreakdown.output.shape.cacheSavingsMicros,
    series: billingUsageBreakdown.output.shape.series,

    byModel: billingUsageBreakdown.output.shape.byModel,
    bySurface: billingUsageBreakdown.output.shape.bySurface,
    byWorkspace: billingUsageBreakdown.output.shape.byWorkspace,
    /**
     * v1 called this `byCapability`. §3: a governed action is one kernel call,
     * and the toolbelt is how an agent reaches it — §12.7 names the key "tool".
     * The schema carries by reference; only the word the caller reads changes.
     */
    byTool: billingUsageBreakdown.output.shape.byCapability,
    /** Who spent it — human, agent or service (§12.7's operator/agent levels). */
    byPrincipal: billingUsageBreakdown.output.shape.byPrincipal,

    // New, from §12.7's key list. Same row shape as every other breakdown, so a
    // client renders one table component for all of them.
    byProviderKey: z.array(breakdownRow),
    byTask: z.array(breakdownRow),
    byRepository: z.array(
      breakdownRow.extend({
        // Carried: the repo's human label, so the rollup does not have to be
        // joined back against the connection to be readable.
        displayName: repoMetrics.output.shape.displayName,
      }),
    ),

    /**
     * Carried whole from list_routing_stats: per (task class, model) samples,
     * verified rate, average cost and latency. This is the evidence behind
     * §12.8's "Wrong tier" finding — a proven run on a light model at high
     * retry, or a flagship model doing classification.
     */
    byTaskClassModel: routerStatsList.output.shape.rows,

    /**
     * §12.8, new. Proven spend is spend on runs whose witness verdict flipped;
     * human-accepted runs are reported separately and are never folded into
     * proven, which is why these are three fields and not one ratio.
     */
    value: z.object({
      provenMicros: z.number().int().nonnegative(),
      acceptedMicros: z.number().int().nonnegative(),
      unprovenMicros: z.number().int().nonnegative(),
      /** Share of steps that advanced the task, 0–1 (§12.8). */
      productiveRatio: z.number().min(0).max(1),
      /** Null until at least one run in the window is proven. */
      spendPerProvenRunMicros: z.number().int().nonnegative().nullable(),
    }),
  }),
});

export type GetSpendInput = z.output<typeof getSpend.input>;
export type GetSpendOutput = z.output<typeof getSpend.output>;
