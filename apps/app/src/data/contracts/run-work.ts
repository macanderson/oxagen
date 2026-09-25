import { z } from "zod";
import { PublicId } from "./common";
const ciCountsSchema = z.object({
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  pending: z.number(),
  skipped: z.number(),
  neutral: z.number(),
});
const ciOverallSchema = z.enum([
  "passing",
  "failing",
  "pending",
  "neutral",
  "unknown",
]);
const ciRunSchema = z.object({
  name: z.string(),
  status: z.enum(["queued", "in_progress", "completed"]),
  conclusion: z
    .enum([
      "success",
      "failure",
      "neutral",
      "cancelled",
      "timed_out",
      "action_required",
      "skipped",
      "stale",
    ])
    .nullable(),
  url: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  app: z.string().nullable(),
});
const runRepositorySchema = z
  .object({
    host: z.string(),
    owner: z.string(),
    name: z.string(),
    url: z.url(),
    connected: z.boolean(),
  })
  .strict();
const runCheckoutSchema = z
  .object({
    ref: z.string(),
    path: z.string(),
    branch: z.string().nullable(),
    headSha: z.string().nullable(),
    remoteDigest: z.string().nullable(),
    repository: runRepositorySchema.nullable(),
    firstSeq: z.string(),
    lastSeq: z.string(),
  })
  .strict();
const runCapturedDiffSchema = z
  .object({
    checkoutRef: z.string(),
    seq: z.string(),
    baseSha: z.string().nullable(),
    headSha: z.string().nullable(),
    digest: z.string().nullable(),
    bodyAvailable: z.boolean(),
    completeness: z.enum([
      "complete",
      "partial",
      "not_retained",
      "not_captured",
    ]),
    limitations: z.array(z.string()),
    observedAt: z.string(),
  })
  .strict();
const runPrDiffFileSchema = z
  .object({
    path: z.string(),
    previousPath: z.string().nullable(),
    status: z.string(),
    additions: z.number(),
    deletions: z.number(),
    patch: z.string().nullable(),
  })
  .strict();
/**
 * The issues a pull request closes on merge, as GitHub records them (closing
 * keywords and sidebar links). Null when they could not be read, so an unread
 * list never reads as "closes nothing".
 */
const runPrClosingIssuesSchema = z
  .object({
    issues: z.array(
      z
        .object({
          owner: z.string(),
          repo: z.string(),
          number: z.number().int(),
          title: z.string(),
          url: z.url(),
          state: z.enum(["open", "closed"]),
        })
        .strict(),
    ),
    complete: z.boolean(),
  })
  .strict();
const runWorkPrSchema = z
  .object({
    repository: runRepositorySchema,
    number: z.number().int(),
    url: z.url(),
    title: z.string(),
    state: z.enum(["open", "closed", "merged"]),
    headSha: z.string().nullable(),
    headRef: z.string(),
    /** The branch the pull request merges into, as GitHub records it. */
    baseRef: z.string(),
    association: z.enum(["recorded", "head_commit", "branch"]),
    closingIssues: runPrClosingIssuesSchema.nullable(),
    checkoutRefs: z.array(z.string()),
    observedAt: z.string(),
    current: z.boolean(),
    ci: z
      .object({
        overall: ciOverallSchema,
        counts: ciCountsSchema,
        runs: z.array(ciRunSchema),
        complete: z.boolean(),
      })
      .nullable(),
    diff: z
      .object({
        digest: z.string(),
        headSha: z.string(),
        files: z.array(runPrDiffFileSchema),
        complete: z.boolean(),
        limitations: z.array(z.string()),
      })
      .nullable(),
  })
  .strict();

/**
 * One subagent the session started, as its hook frames recorded it.
 * `agentRef` is the harness's own agent id (`hook.agent_id`). Oxagen neither
 * mints nor validates it, so it is a `…Ref`, not a `PublicId` (INV-11).
 */
export const RunSubagent = z
  .object({
    agentRef: z.string(),
    type: z.string().nullable(),
    firstSeq: z.string(),
    lastSeq: z.string(),
    stopped: z.boolean(),
  })
  .strict();
export type RunSubagent = z.infer<typeof RunSubagent>;

export const RunWork = z
  .object({
    runId: PublicId,
    machine: z.object({ name: z.string() }).nullable(),
    checkouts: z.array(runCheckoutSchema),
    diffs: z.array(runCapturedDiffSchema),
    pullRequests: z.array(runWorkPrSchema),
    subagents: z.array(RunSubagent).optional(),
    complete: z.boolean(),
    warnings: z.array(z.string()),
  })
  .strict();
export type RunWork = z.infer<typeof RunWork>;

export const RunOutcomesPolicy = z
  .object({
    customerEnabled: z.boolean(),
    platformDisabled: z.boolean(),
    platformDisabledReason: z.string().nullable(),
    effectiveEnabled: z.boolean(),
  })
  .strict();
export type RunOutcomesPolicy = z.infer<typeof RunOutcomesPolicy>;
