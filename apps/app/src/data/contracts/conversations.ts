// The assistant's thread as the flyout reopens it (#4163): the viewer's
// latest conversation in a workspace, read back through `get_conversation`,
// and the turns on it. Only what the flyout draws is carried: the question,
// the reply with the run it was recorded as, the tool calls that run made
// (#4161), and the writes it parked.
import { z } from "zod";
import { PublicId } from "./common";

/** A governed write a turn parked for a person (`ask_assistant`'s card). */
const ParkedWrite = z.object({
  approvalId: PublicId,
  capability: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
});

/**
 * One tool call behind a reply, as `get_conversation` reads it from the
 * reply's run.
 *
 * `toolCallRef` is **a `…Ref`, not an id field, because it is not one of
 * ours.** The engine mints it for its own call, and Oxagen neither issues it
 * nor can validate it, so INV-11 carries it under a name that says what it is
 * rather than claiming a public id it is not (`mandates.ts` carries the same
 * reasoning for `externalEffectRef`).
 *
 * `approvalId` names the approval a parked call waits on, and is null for
 * every other outcome. It is the approval's own public id (`apr_…`), the same
 * id its entry in `parked` carries, so it is a `PublicId`.
 */
const ToolCall = z.object({
  toolCallRef: z.string().min(1),
  toolName: z.string().min(1),
  outcome: z.enum(["completed", "failed", "denied", "cancelled", "parked"]),
  durationMs: z.number().int().nonnegative(),
  approvalId: PublicId.nullable(),
});

/**
 * One turn's half. A question carries no run, parks nothing, and calls no
 * tool. A reply carries the run it was recorded as, or null when no turn
 * recorded one, and the tool calls that run made.
 */
export const ThreadMessage = z.object({
  id: PublicId,
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  runId: PublicId.nullable(),
  parked: z.array(ParkedWrite),
  toolCalls: z.array(ToolCall),
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
