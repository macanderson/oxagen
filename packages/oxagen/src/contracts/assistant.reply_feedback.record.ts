/**
 * `record_reply_feedback`: a person's verdict on one reply of the in-app
 * assistant, `useful` or `wrong`, with an optional short note (#4169).
 *
 * The reply is named by the run it was recorded as (`ask_assistant` returns
 * `runId`) and the conversation it sits in. The handler refuses unless the run
 * is an assistant run in this workspace and the reply sits in a conversation
 * the caller owns, so nobody records a verdict on someone else's turn. It then
 * appends one row to ClickHouse `assistant_reply_feedback` (migration 0030):
 * the verdict is an append-only event keyed by the run, which is the store
 * AGENTS.md puts events in. A second vote is a second row. A reader takes the
 * newest per person and run (`readReplyFeedback`, `@oxagen/telemetry`), and
 * that is how the replay set finds the turns people marked wrong.
 *
 * Not on the `agent` surface. The verdict is the person's judgment of what
 * the assistant said. A tool the assistant could call would let the model
 * grade its own replies inside the turn it is answering, and a label the
 * graded party can write is not evidence of anything.
 *
 * Not a governed action (ADR-052 exclusion 2): `noBillingGate: true`. A
 * person rating a reply acts on no agent, grants nothing, and spends nothing,
 * so it neither draws a governed action unit nor waits on the admission gate.
 * The roles are `ask_assistant`'s, because the people who may ask are the
 * people who may rate what they were told.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * The longest note a vote carries: 500 characters. That holds two or three
 * sentences naming what was wrong (the run, the number, the step), which is
 * what a reviewer reads beside the reply. It is bounded because the row is
 * append-only and never deleted before its TTL, so an unbounded note would let
 * one request write any amount of text into a table nobody can trim.
 */
export const REPLY_FEEDBACK_NOTE_MAX_CHARS = 500;

/** The two verdicts, in the order the flyout offers them. */
export const replyFeedbackVerdictSchema = z.enum(["useful", "wrong"]);

/** `arun_...`: the run a reply was recorded as, as `ask_assistant` returns it. */
const assistantRunIdSchema = z.string().regex(/^arun_[0-9a-z]+$/);

export const assistantReplyFeedbackRecord = registerCapability({
  name: "record_reply_feedback",
  domain: "assistant",
  description:
    "Record a person's verdict on one reply of the in-app assistant, useful or wrong, with an optional short note, against the run the reply was recorded as. Refused unless the run is an assistant run in this workspace whose reply sits in the caller's own conversation.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  mutates: true,
  noBillingGate: true,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      /** The conversation the reply sits in: `ask_assistant`'s `conversationId`. */
      conversationId: z.string().uuid(),
      /** The run the reply was recorded as: `ask_assistant`'s `runId`. */
      runId: assistantRunIdSchema,
      verdict: replyFeedbackVerdictSchema,
      /** Null or absent for no note. Trimmed, then 1 to 500 characters. */
      note: z
        .string()
        .trim()
        .min(1)
        .max(REPLY_FEEDBACK_NOTE_MAX_CHARS)
        .nullable()
        .default(null),
    })
    .strict(),
  output: z
    .object({
      runId: assistantRunIdSchema,
      conversationId: z.string().uuid(),
      /** The assistant message the verdict is about, resolved from the run. */
      messageId: z.string().uuid(),
      verdict: replyFeedbackVerdictSchema,
      note: z.string().nullable(),
      /** RFC 3339: when the vote was recorded, the row's `created_at`. */
      recordedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
});

export type AssistantReplyFeedbackRecordInput = z.output<
  typeof assistantReplyFeedbackRecord.input
>;
export type AssistantReplyFeedbackRecordOutput = z.output<
  typeof assistantReplyFeedbackRecord.output
>;
export type ReplyFeedbackVerdict = z.output<typeof replyFeedbackVerdictSchema>;
