import { describe, expect, it } from "vitest";
import { assistantAsk } from "./assistant.ask";
import {
  assistantReplyFeedbackRecord,
  REPLY_FEEDBACK_NOTE_MAX_CHARS,
} from "./assistant.reply_feedback.record";

const CONVERSATION = "0192d4a8-7c1e-7a00-8000-0000000000c1";
const RUN = "arun_0123456789abcdef012345";

describe("record_reply_feedback contract", () => {
  it("is a scoped, mutating, low-sensitivity write that is not a governed action (ADR-052 exclusion 2)", () => {
    expect(assistantReplyFeedbackRecord.name).toBe("record_reply_feedback");
    expect(assistantReplyFeedbackRecord.mode).toBe("sync");
    expect(assistantReplyFeedbackRecord.scoped).toBe(true);
    expect(assistantReplyFeedbackRecord.mutates).toBe(true);
    expect(assistantReplyFeedbackRecord.noBillingGate).toBe(true);
    expect(assistantReplyFeedbackRecord.sensitivity).toBe("low");
    expect(assistantReplyFeedbackRecord.defaultEffect).toBe("deny");
  });

  it("grants the roles ask_assistant grants: whoever may ask may rate the answer", () => {
    expect(assistantReplyFeedbackRecord.defaultRoles).toEqual(
      assistantAsk.defaultRoles,
    );
  });

  it("is the person's and not the model's: never on the agent surface", () => {
    expect(assistantReplyFeedbackRecord.surfaces).toEqual(["api", "mcp"]);
    expect(assistantReplyFeedbackRecord.surfaces).not.toContain("agent");
    expect(assistantReplyFeedbackRecord.layers).toContain("app");
  });

  it("takes a verdict against a run and defaults the note to none", () => {
    expect(
      assistantReplyFeedbackRecord.input.parse({
        conversationId: CONVERSATION,
        runId: RUN,
        verdict: "useful",
      }),
    ).toEqual({
      conversationId: CONVERSATION,
      runId: RUN,
      verdict: "useful",
      note: null,
    });
  });

  it("trims a note and admits one of exactly the cap", () => {
    expect(
      assistantReplyFeedbackRecord.input.parse({
        conversationId: CONVERSATION,
        runId: RUN,
        verdict: "wrong",
        note: "  It named the wrong agent.  ",
      }).note,
    ).toBe("It named the wrong agent.");
    expect(
      assistantReplyFeedbackRecord.input.safeParse({
        conversationId: CONVERSATION,
        runId: RUN,
        verdict: "wrong",
        note: "x".repeat(REPLY_FEEDBACK_NOTE_MAX_CHARS),
      }).success,
    ).toBe(true);
  });

  it("refuses a note past the cap, a blank note, another verdict, a tacho run and an unknown key (negative)", () => {
    const base = { conversationId: CONVERSATION, runId: RUN, verdict: "wrong" };
    expect(REPLY_FEEDBACK_NOTE_MAX_CHARS).toBe(500);
    expect(
      assistantReplyFeedbackRecord.input.safeParse({
        ...base,
        note: "x".repeat(REPLY_FEEDBACK_NOTE_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(
      assistantReplyFeedbackRecord.input.safeParse({ ...base, note: "   " })
        .success,
    ).toBe(false);
    expect(
      assistantReplyFeedbackRecord.input.safeParse({
        ...base,
        verdict: "meh",
      }).success,
    ).toBe(false);
    expect(
      assistantReplyFeedbackRecord.input.safeParse({
        ...base,
        runId: "tse_abc",
      }).success,
    ).toBe(false);
    expect(
      assistantReplyFeedbackRecord.input.safeParse({
        ...base,
        conversationId: "cnv_1",
      }).success,
    ).toBe(false);
    expect(
      assistantReplyFeedbackRecord.input.safeParse({ ...base, score: 5 })
        .success,
    ).toBe(false);
  });

  it("answers with the message the verdict landed on and when", () => {
    const output = {
      runId: RUN,
      conversationId: CONVERSATION,
      messageId: "0192d4a8-7c1e-7a00-8000-0000000000d2",
      verdict: "wrong",
      note: null,
      recordedAt: "2026-09-25T10:00:00.000Z",
    };
    expect(assistantReplyFeedbackRecord.output.parse(output)).toEqual(output);
    expect(
      assistantReplyFeedbackRecord.output.safeParse({
        ...output,
        recordedAt: "yesterday",
      }).success,
    ).toBe(false);
  });
});
