import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * billing.usage.breakdown
 *
 * Grouped usage aggregates (tokens + cost + call counts) for a bounded window,
 * broken down by model, surface, and workspace, plus a daily time series. Powers
 * the usage dashboard — the metering→billing visibility that is the wedge.
 *
 * Read-only. `noBillingGate: true`: a read of your own spend must not itself be
 * charged or gated on credit balance — otherwise an org that runs out of credits
 * could no longer see that it had run out. It still flows through invoke(), so
 * the call is observed (OTEL span, surface tag, duration) like every capability.
 */

const totals = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** Prompt-cache READ tokens (cache hits) — a subset of inputTokens. */
  cachedTokens: z.number().int().nonnegative(),
  /**
   * Prompt-cache WRITE tokens (cache creation) — a subset of inputTokens billed
   * at the provider premium. Zero on rows recorded before cache-write tracking
   * existed.
   */
  cacheWriteTokens: z.number().int().nonnegative(),
  /** Cost in micro-USD (1 USD = 1_000_000). */
  costMicros: z.number().int().nonnegative(),
  /** Number of metered LLM calls (token_usage rows). */
  executions: z.number().int().nonnegative(),
  /** Distinct chat-turn count (execution_step_id); <= executions. */
  messages: z.number().int().nonnegative(),
});

const breakdownRow = totals.extend({
  /** Grouping key: model id, surface name, workspace_id UUID, or capability name. */
  key: z.string(),
  /** Provider slug — populated for the model breakdown only, else "". */
  provider: z.string(),
});

const principalRow = totals.extend({
  /** Acting principal uuid; the nil UUID groups unattributed pre-spine/system spend. */
  principalId: z.string(),
  /** "human" | "agent" | "service", or "" for unattributed rows. */
  principalKind: z.string(),
});

const userRow = totals.extend({
  /** Acting user uuid; the nil UUID groups unattributed (non-human/system) rows. */
  userId: z.string(),
});

// A one-year ceiling bounds the ClickHouse scan and the payload's series length.
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

// Per-field schemas exported so surfaces (e.g. the xmcp tool) can build their own
// arg map — the contract `input` wraps these in `.refine()` cross-field checks
// (a ZodEffects), which has no `.shape`, so surfaces cannot destructure it.
export const billingUsageBreakdownFields = {
  start: z
    .string()
    .datetime({ offset: true })
    .describe("ISO-8601 start of the window (inclusive)"),
  end: z
    .string()
    .datetime({ offset: true })
    .describe("ISO-8601 end of the window (exclusive)"),
  workspaceId: z
    .string()
    .uuid()
    .optional()
    .describe("Narrow the breakdown to a single workspace (omit for org-wide)"),
} as const;

export const billingUsageBreakdown = registerCapability({
  name: "get_usage_breakdown",
  domain: "billing",
  description:
    "Aggregated usage for a time window broken down by model, surface, workspace, capability, acting principal, and user, plus a daily time series of tokens, cost, and chat-turn (message) counts. Org-scoped; pass workspaceId to narrow to one workspace. Powers the usage dashboard and per-seat/per-agent metering.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs", "app"],
  scoped: true,
  // Reading your own usage must never consume credits — see file header.
  noBillingGate: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "billing",
  },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow" },
    workspace: {},
  },
  input: z
    .object(billingUsageBreakdownFields)
    .refine((v) => new Date(v.end).getTime() > new Date(v.start).getTime(), {
      message: "end must be after start",
      path: ["end"],
    })
    .refine(
      (v) =>
        new Date(v.end).getTime() - new Date(v.start).getTime() <= MAX_RANGE_MS,
      { message: "range must not exceed 366 days", path: ["end"] },
    ),
  output: z.object({
    range: z.object({ start: z.string(), end: z.string() }),
    totals,
    /**
     * Estimated cache savings in micro-USD over the window, NET of the cache-write
     * premium: the reads served cheaply (inputPer1M − cachedInputPer1M per cached
     * token) minus what the writes cost above fresh input (cacheWritePer1M −
     * inputPer1M per write token), summed across models via the provider rate card.
     * Positive = caching netted the org money; can go negative for a workload that
     * paid the write premium without reaping enough reads. Powers the dashboard's
     * "cache savings" figure — the discount a cache-friendly agent earns.
     */
    cacheSavingsMicros: z.number().int(),
    series: z.array(
      totals.extend({ day: z.string().describe("YYYY-MM-DD (UTC)") }),
    ),
    byModel: z.array(breakdownRow),
    bySurface: z.array(breakdownRow),
    byWorkspace: z.array(breakdownRow),
    /** Per-capability spend (principal spine, migration 0023). Pre-spine rows key "". */
    byCapability: z.array(breakdownRow),
    /** Per-principal spend — who spent it (human | agent | service). */
    byPrincipal: z.array(principalRow),
    /** Per-user spend — seat-level "who used it" view keyed on token_usage.user_id. */
    byUser: z.array(userRow),
  }),
});

export type BillingUsageBreakdownInput = z.output<
  typeof billingUsageBreakdown.input
>;
export type BillingUsageBreakdownOutput = z.output<
  typeof billingUsageBreakdown.output
>;
