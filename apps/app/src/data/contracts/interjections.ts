// The questions agents paused to ask a person, as Fleet's waiting tile and
// the shell's approvals drawer read them, from `list_interjections` (#3839).
// A field is nullable exactly where the contract may not have recorded it
// (§3.4), and a null renders as "not recorded".
import { z } from "zod";
import { PublicId } from "./common";

/** One open question: the run that asked, what it asked, and until when it waits. */
export const InterjectionItem = z.object({
  id: PublicId,
  runId: PublicId,
  /** `org_ns.ws_ns.slug` (ADR-024); null when the writer recorded none. */
  agentKey: z.string().min(1).nullable(),
  question: z.string().min(1),
  raisedAt: z.iso.datetime({ offset: true }),
  /** When the run stops waiting and carries on without an answer. */
  expiresAt: z.iso.datetime({ offset: true }),
});
export type InterjectionItem = z.infer<typeof InterjectionItem>;

/**
 * The open questions, walked to the end of the cursor under a bound, the same
 * shape as `ApprovalQueue`. `more` says when the bound stopped the walk, so a
 * count reads as a floor rather than as the whole queue.
 */
export const InterjectionQueue = z.object({
  items: z.array(InterjectionItem),
  /** True when the queue holds questions past the ones in `items`. */
  more: z.boolean(),
});
export type InterjectionQueue = z.infer<typeof InterjectionQueue>;
