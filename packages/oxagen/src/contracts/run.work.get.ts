import { z } from "zod";
import { registerCapability } from "../registry";
import { runPublicIdSchema } from "./run.list";
import { ciCountsSchema, ciOverallSchema, ciRunSchema } from "./repo.ci.status";

export const runRepositorySchema = z
  .object({
    host: z.string(),
    owner: z.string(),
    name: z.string(),
    url: z.string().url(),
    connected: z.boolean(),
  })
  .strict();
export const runCheckoutSchema = z
  .object({
    id: z.string(),
    path: z.string(),
    branch: z.string().nullable(),
    headSha: z.string().nullable(),
    remoteDigest: z.string().nullable(),
    repository: runRepositorySchema.nullable(),
    firstSeq: z.string(),
    lastSeq: z.string(),
  })
  .strict();
export const runCapturedDiffSchema = z
  .object({
    checkoutId: z.string(),
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
export const runPrDiffFileSchema = z
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
          url: z.string().url(),
          state: z.enum(["open", "closed"]),
        })
        .strict(),
    ),
    complete: z.boolean(),
  })
  .strict();
export const runWorkPrSchema = z
  .object({
    repository: runRepositorySchema,
    number: z.number().int(),
    url: z.string().url(),
    title: z.string(),
    state: z.enum(["open", "closed", "merged"]),
    headSha: z.string().nullable(),
    headRef: z.string(),
    /** The branch the pull request merges into, as GitHub records it. */
    baseRef: z.string(),
    association: z.enum(["recorded", "head_commit", "branch"]),
    closingIssues: runPrClosingIssuesSchema.nullable(),
    checkoutIds: z.array(z.string()),
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
 * One subagent the session started, from its `subagent_start` and
 * `subagent_stop` hook frames. `type` is the agent type the harness named;
 * `stopped` is false while no stop frame has been recorded.
 */
export const runSubagentSchema = z
  .object({
    id: z.string(),
    type: z.string().nullable(),
    firstSeq: z.string(),
    lastSeq: z.string(),
    stopped: z.boolean(),
  })
  .strict();

/** The most releases one answer carries. */
export const RUN_RELEASE_MAX = 20;

/**
 * A release the session created, from the command frame that created it
 * (#3890), with its state as GitHub reads it now.
 */
export const runReleaseSchema = z
  .object({
    repository: runRepositorySchema,
    tag: z.string().min(1),
    /** The release title GitHub records; null when it has none or was not read. */
    name: z.string().nullable(),
    url: z.string().url().nullable(),
    /**
     * Null when GitHub has no release with that tag (`release_not_found`) or
     * it could not be read (`release_read_failed`).
     */
    state: z.enum(["draft", "prerelease", "published"]).nullable(),
    /** The command frame that created the release. */
    frameSeq: z.string().regex(/^\d+$/),
    /** RFC 3339: when that frame was recorded; null when it recorded no time. */
    observedAt: z.string().datetime().nullable(),
  })
  .strict();

export const runWorkGet = registerCapability({
  name: "get_run_work",
  domain: "run",
  description:
    "Read recorded checkout locations and retained diff references, plus connected pull requests and their current CI checks.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "app", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({ runId: runPublicIdSchema }).strict(),
  output: z
    .object({
      runId: runPublicIdSchema,
      machine: z.object({ name: z.string() }).nullable(),
      checkouts: z.array(runCheckoutSchema),
      diffs: z.array(runCapturedDiffSchema),
      pullRequests: z.array(runWorkPrSchema),
      /** The subagents the session started; empty for a ledger run. */
      subagents: z.array(runSubagentSchema),
      /** The releases the session created; empty for a ledger run (#3890). */
      releases: z.array(runReleaseSchema).max(RUN_RELEASE_MAX),
      complete: z.boolean(),
      /**
       * Machine-readable notes on what the read could not do. A release adds
       * `release_not_found` when GitHub has no release with the recorded tag,
       * and `release_read_failed` when GitHub could not be read.
       */
      warnings: z.array(z.string()),
    })
    .strict(),
});

export type RunRepository = z.output<typeof runRepositorySchema>;
export type RunCheckout = z.output<typeof runCheckoutSchema>;
export type RunCapturedDiff = z.output<typeof runCapturedDiffSchema>;
export type RunWorkPr = z.output<typeof runWorkPrSchema>;
export type RunSubagent = z.output<typeof runSubagentSchema>;
export type RunRelease = z.output<typeof runReleaseSchema>;
export type RunWorkGetOutput = z.output<typeof runWorkGet.output>;
