// The assistant's thread as the flyout reopens it (#4163): the viewer's
// latest conversation in a workspace, read back through `get_conversation`,
// and the turns on it. Only what the flyout draws is carried: the question,
// the reply with the run it was recorded as, the writes it parked, and
// whether the person stopped it.
import { z } from "zod";
import { PublicId } from "./common";

/** A governed write a turn parked for a person (`ask_assistant`'s card). */
const ParkedWrite = z.object({
  approvalId: PublicId,
  capability: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
});

/**
 * One turn's half. A question carries no run and parks nothing; a reply
 * carries the run it was recorded as, or null when no turn recorded one.
 */
export const ThreadMessage = z.object({
  id: PublicId,
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  runId: PublicId.nullable(),
  parked: z.array(ParkedWrite),
  /** The person stopped the turn, so `text` is what it reached (#4164). */
  stopped: z.boolean(),
});
export type ThreadMessage = z.infer<typeof ThreadMessage>;

/** The conversation and its newest turns, oldest first. */
export const AssistantThread = z.object({
  /** The `cnv_` id `ask_assistant` continues the conversation by. */
  id: PublicId,
  messages: z.array(ThreadMessage),
  /** True when earlier turns were left out. */
  truncated: z.boolean(),
});
export type AssistantThread = z.infer<typeof AssistantThread>;
