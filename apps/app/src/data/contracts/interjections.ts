// The questions agents paused to ask a person, as Fleet's waiting tile, the
// shell's approvals drawer and the Run page read them, from
// `list_interjections` (#3839, #3941).
// A field is nullable exactly where the contract may not have recorded it
// (§3.4), and a null renders as "not recorded".
import { z } from "zod";
import { PublicId } from "./common";

/**
 * The `control.interject` body a host sealed for a repository its workspace
 * has not bound (#3941), camelCased from `list_interjections`. The Run page
 * renders the question, the two paths and the timeout from it.
 */
const InterjectBody = z.object({
  /** The ULID the host minted for the interjection; not a public id. */
  interjectionKey: z.string().min(1),
  reason: z.literal("repo_unknown"),
  /** The question exactly as the harness showed it. */
  question: z.string().min(1),
  remoteDigest: z.string().min(1),
  remoteDigestFolded: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive(),
  /** The host's deadline; the row's `expiresAt` is the control plane's. */
  expiresAt: z.iso.datetime({ offset: true }),
  onTimeout: z.literal("deny"),
  /** Link first, then create. */
  paths: z.tuple([
    z.object({
      path: z.literal("link"),
      workspaceSlug: z.string().min(1),
      configVersion: z.string().min(1).nullable(),
      /** Skills the workspace's configuration pins; null when not counted. */
      skillsPinned: z.number().int().nonnegative().nullable(),
      /** Repositories the workspace already links; null when not counted. */
      linkedRepositories: z.number().int().nonnegative().nullable(),
    }),
    z.object({
      path: z.literal("create"),
      proposedName: z.string().min(1).nullable(),
      proposedSlug: z.string().min(1).nullable(),
      skillsEnabled: z.literal(false),
    }),
  ]),
});

/** One question: the run that asked, what it asked, until when it waits, and its answer. */
export const InterjectionItem = z.object({
  id: PublicId,
  runId: PublicId,
  /** `org_ns.ws_ns.slug` (ADR-024); null when the writer recorded none. */
  agentKey: z.string().min(1).nullable(),
  question: z.string().min(1),
  raisedAt: z.iso.datetime({ offset: true }),
  /** When the run stops waiting and carries on without an answer. */
  expiresAt: z.iso.datetime({ offset: true }),
  /** Null while the question is open. */
  answeredAt: z.iso.datetime({ offset: true }).nullable(),
  /** The answer as recorded; null while the question is open. */
  answer: z.string().nullable(),
  /** The person who answered; null while open, and on a timeout. */
  answeredBy: PublicId.nullable(),
  /**
   * `question` is an agent asking in its own words. `repo_unknown` is a host
   * holding a session that started in a repository the workspace has not
   * bound.
   */
  kind: z.enum(["question", "repo_unknown"]),
  /** The frame that raised a `repo_unknown` row, on the run's own chain; null on a question. */
  raisedSeq: z.string().regex(/^\d+$/).nullable(),
  /** The body the host sealed; null on a question. */
  body: InterjectBody.nullable(),
  /** `owner/name`; null until the control plane resolves it, or when nothing matches. */
  repository: z.string().min(1).nullable(),
  /** How a `repo_unknown` row was settled; null while open and on a question. */
  path: z.enum(["link", "create", "deny"]).nullable(),
  /** The receipt minted with the answer; null while open. */
  receiptId: PublicId.nullable(),
});
export type InterjectionItem = z.infer<typeof InterjectionItem>;

/**
 * A page of questions, walked to the end of the cursor under a bound, the
 * same shape as `ApprovalQueue`: the open ones for Fleet and the drawer, or
 * one run's, answered or not, for the Run page. `more` says when the bound
 * stopped the walk, so a count reads as a floor rather than as the whole
 * queue.
 */
export const InterjectionQueue = z.object({
  items: z.array(InterjectionItem),
  /** True when the queue holds questions past the ones in `items`. */
  more: z.boolean(),
});
export type InterjectionQueue = z.infer<typeof InterjectionQueue>;
