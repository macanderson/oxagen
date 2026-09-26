// The Run page's Issues tab view model, from `get_run_issues` (#3970): the
// issues one run worked on, each with its state as the forge reads it now,
// whether that read happened, and the frames that show the link. Every field
// mirrors the contract, and a status the read could not take stays null with
// its reason beside it.
import { z } from "zod";
import { PublicId } from "./common";

const RunIssueRepository = z
  .object({
    host: z.string(),
    owner: z.string(),
    name: z.string(),
    url: z.url(),
    connected: z.boolean(),
  })
  .strict();

const RunIssue = z
  .object({
    /** `owner/repo#N`, `#N` when the repository is unresolved, or a tracker key. */
    ref: z.string().min(1),
    repository: RunIssueRepository.nullable(),
    number: z.number().int().positive().nullable(),
    title: z.string().nullable(),
    /** Null unless `statusRead` is `read`. */
    status: z.enum(["open", "closed", "in_progress", "blocked"]).nullable(),
    statusRead: z.enum([
      "read",
      "no_connection",
      "not_github",
      "repository_unknown",
      "not_found",
      "read_failed",
      "read_limit",
    ]),
    readAt: z.iso.datetime({ offset: true }).nullable(),
    relation: z.enum(["task", "resolves", "referenced"]),
    /** The run's pull requests that close the issue; empty unless it `resolves`. */
    resolvedBy: z
      .array(
        z
          .object({
            number: z.number().int().positive(),
            url: z.url(),
          })
          .strict(),
      )
      .max(20),
    actions: z.array(
      z.enum([
        "viewed",
        "commented",
        "created",
        "edited",
        "closed",
        "reopened",
        "mentioned",
      ]),
    ),
    edge: z.enum(["stated", "observed"]),
    frameSeqs: z.array(z.string().regex(/^\d+$/)).max(20),
    url: z.url().nullable(),
  })
  .strict();

export const RunIssues = z
  .object({
    runId: PublicId,
    issues: z.array(RunIssue),
    /** False when a read limit cut the list; `warnings` says which. */
    complete: z.boolean(),
    warnings: z.array(z.string()),
  })
  .strict();
export type RunIssues = z.infer<typeof RunIssues>;
