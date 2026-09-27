/**
 * `get_run_issues`: the issues one run worked on, and what it did to each
 * (#3970). The Run page's Issues tab reads it.
 *
 * An issue reaches the list three ways, named by `relation`:
 *
 * - `task`: the run was admitted for it (a ledger run's `taskRef`).
 * - `resolves`: a pull request the run opened closes it on merge, as GitHub
 *   records the closing reference.
 * - `referenced`: a frame of the run names it, for example a GitHub tool call
 *   that read, commented on, created or closed it.
 *
 * `edge` says how the record knows: `stated` for the task the run was
 * admitted for, `observed` when a frame shows it (a pull-request receipt, or
 * a tool call on the issue). No link is inferred from a branch name or from
 * model output.
 *
 * `status` is the issue's state as the forge reads it now, and `statusRead`
 * says whether that read happened and why not. An issue whose state could not
 * be read keeps `status: null`, and a caller renders "status unknown" rather
 * than a guess.
 *
 * `warnings` is a closed vocabulary of the limits the read hit:
 * `closing_issue_limit`, `closing_issues_read_failed`,
 * `recorded_repository_not_connected`, `issue_frame_limit`,
 * `tracker_read_limit`, `pull_request_ref_skipped`, `chain_break` and
 * `ledger_event_limit`. `complete` is false when any of them cut the list.
 *
 * `noBillingGate: true`: reading a recording is a console read (§1.5).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { runPublicIdSchema } from "./run.list";
import { runRepositorySchema } from "./run.work.get";

/** The most issues one answer carries. */
export const RUN_ISSUE_MAX = 200;

/** The issue's state as the forge reads it now. */
export const RUN_ISSUE_STATUSES = [
  "open",
  "closed",
  "in_progress",
  "blocked",
] as const;

/** How the issue came to be on the run's list. */
export const RUN_ISSUE_RELATIONS = ["task", "resolves", "referenced"] as const;

/** What the run's frames show it doing to the issue. */
export const RUN_ISSUE_ACTIONS = [
  "viewed",
  "commented",
  "created",
  "edited",
  "closed",
  "reopened",
  "mentioned",
] as const;

/**
 * Whether `status` was read, and why not when it was not: `read`, or the
 * workspace has no connection to the forge (`no_connection`), the issue is
 * not on GitHub (`not_github`), its repository is not known
 * (`repository_unknown`), GitHub has no such issue (`not_found`), the read
 * failed (`read_failed`), or the read stopped at its limit (`read_limit`).
 */
export const RUN_ISSUE_STATUS_READS = [
  "read",
  "no_connection",
  "not_github",
  "repository_unknown",
  "not_found",
  "read_failed",
  "read_limit",
] as const;

/** The most frames and closing pull requests one issue carries. */
const RUN_ISSUE_REF_MAX = 20;

export const runIssueSchema = z
  .object({
    /**
     * The issue as the record names it: `owner/repo#N`, `#N` when the
     * repository is not resolved, or a tracker key as recorded.
     */
    ref: z.string().min(1),
    /** Null when the record does not resolve the issue's repository. */
    repository: runRepositorySchema.nullable(),
    /** Null for a tracker key that carries no number. */
    number: z.number().int().positive().nullable(),
    /** The title the forge records; null when it was not read. */
    title: z.string().nullable(),
    /** Null unless `statusRead` is `read`. */
    status: z.enum(RUN_ISSUE_STATUSES).nullable(),
    statusRead: z.enum(RUN_ISSUE_STATUS_READS),
    /** RFC 3339: when `status` was read; null when it was not. */
    readAt: z.string().datetime().nullable(),
    relation: z.enum(RUN_ISSUE_RELATIONS),
    /** The run's pull requests that close the issue; empty unless `relation` is `resolves`. */
    resolvedBy: z
      .array(
        z
          .object({
            number: z.number().int().positive(),
            url: z.string().url(),
          })
          .strict(),
      )
      .max(RUN_ISSUE_REF_MAX),
    /** What the run's frames show it doing to the issue, in the order first seen. */
    actions: z.array(z.enum(RUN_ISSUE_ACTIONS)),
    /** `stated` for the run's task, `observed` when a frame shows the link. */
    edge: z.enum(["stated", "observed"]),
    /** The frames that name the issue, seqs ascending. */
    frameSeqs: z.array(z.string().regex(/^\d+$/)).max(RUN_ISSUE_REF_MAX),
    /** The issue's page on the forge; null when the record names none. */
    url: z.string().url().nullable(),
  })
  .strict();

export const runIssuesGet = registerCapability({
  name: "get_run_issues",
  domain: "run",
  description:
    "Read the issues one run worked on: the task it was admitted for, the issues its pull requests close, and the issues its frames name, each with its state as the forge reads it now, whether that state could be read, what the run did to it, and the frames that show it.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "app", "unit", "docs"],
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
      issues: z.array(runIssueSchema).max(RUN_ISSUE_MAX),
      /** False when a read limit cut the list; `warnings` names which. */
      complete: z.boolean(),
      warnings: z.array(z.string()),
    })
    .strict(),
});

export type RunIssue = z.output<typeof runIssueSchema>;
export type RunIssuesGetInput = z.output<typeof runIssuesGet.input>;
export type RunIssuesGetOutput = z.output<typeof runIssuesGet.output>;
