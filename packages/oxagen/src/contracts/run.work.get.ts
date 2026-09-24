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
      complete: z.boolean(),
      warnings: z.array(z.string()),
    })
    .strict(),
});

export type RunRepository = z.output<typeof runRepositorySchema>;
export type RunCheckout = z.output<typeof runCheckoutSchema>;
export type RunCapturedDiff = z.output<typeof runCapturedDiffSchema>;
export type RunWorkPr = z.output<typeof runWorkPrSchema>;
export type RunSubagent = z.output<typeof runSubagentSchema>;
export type RunWorkGetOutput = z.output<typeof runWorkGet.output>;
