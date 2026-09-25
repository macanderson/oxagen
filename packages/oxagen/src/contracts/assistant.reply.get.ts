/**
 * `get_assistant_reply`: the reply an in-app agent turn left on the record,
 * read by the run the turn was recorded as (ADR-XXX).
 *
 * The app streams a turn over `POST /v1/:org/:ws/chat/stream`, and a dropped
 * connection does not stop it: the turn runs to completion and persists its
 * reply as the assistant's message (ADR-092). This read is how a client that
 * lost the stream gets the finished reply back. The stream names the run
 * before the engine is asked anything, so a client that received any of the
 * stream holds the id this read takes.
 *
 * The answer reports what the record holds and claims nothing past it:
 *
 * - `reply` is the reply persisted for the run in one of the caller's own
 *   conversations, with that conversation's id so the next question
 *   continues it. Null while none is recorded.
 * - `runStatus` is the run's status on the ledger. `pending` and `running`
 *   mean the turn has not ended. `completed` with no reply means the reply
 *   is still being written: the ledger seals the run just before the reply
 *   is saved. `failed` and `cancelled` mean no reply will be written, and
 *   the run records why.
 *
 * A reply is read only by the person whose conversation it is. An unknown
 * id, a run of another workspace, and a run that is not an assistant turn
 * are all `not_found`.
 *
 * `noBillingGate: true`: reading the record is a console read (ADR-052
 * exclusion 2).
 */
import { z } from "zod";
import { registerCapability } from "../registry";

/** An in-app agent turn's run: `arun_…`. A wrapped session's `tse_…` has no reply. */
export const assistantRunIdSchema = z
  .string()
  .regex(/^arun_[0-9a-z]+$/, "an in-app agent run id (arun_…)");

export const assistantReplyGet = registerCapability({
  name: "get_assistant_reply",
  domain: "assistant",
  description:
    "Read the reply an in-app agent turn left on the record, by the run it was recorded as: the persisted reply and its conversation, or the run's status while no reply is recorded.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  mutates: false,
  noBillingGate: true,
  // The reply is the text of a person's conversation.
  sensitivity: "high",
  defaultEffect: "deny",
  // The people who may ask may read what they were answered: ask_assistant's
  // roles, checked in the handler for every organization tier (INV-29).
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({ runId: assistantRunIdSchema }).strict(),
  output: z
    .object({
      runId: assistantRunIdSchema,
      runStatus: z.enum([
        "pending",
        "running",
        "completed",
        "failed",
        "cancelled",
      ]),
      reply: z
        .object({
          conversationId: z.string().uuid(),
          text: z.string(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
});

export type AssistantReplyGetInput = z.output<typeof assistantReplyGet.input>;
export type AssistantReplyGetOutput = z.output<typeof assistantReplyGet.output>;
