import { describe, expect, it } from "vitest";
import { assistantReplyGet } from "./assistant.reply.get";

const RUN = "arun_0123456789abcdef012345";

describe("get_assistant_reply contract", () => {
  it("is a console read: mutates false, noBillingGate true, scoped", () => {
    expect(assistantReplyGet.mutates).toBe(false);
    expect(assistantReplyGet.noBillingGate).toBe(true);
    expect(assistantReplyGet.scoped).toBe(true);
  });

  it("gives the reply to the roles that may ask, and no one else", () => {
    expect(assistantReplyGet.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow", Member: "allow" },
    });
  });

  it("takes an in-app agent run and nothing else (negative)", () => {
    expect(assistantReplyGet.input.safeParse({ runId: RUN }).success).toBe(
      true,
    );
    expect(
      assistantReplyGet.input.safeParse({ runId: "tse_0123456789" }).success,
    ).toBe(false);
    expect(
      assistantReplyGet.input.safeParse({ runId: RUN, conversationId: "x" })
        .success,
    ).toBe(false);
  });

  it("carries a persisted reply with its conversation, or none beside the run's status", () => {
    const answered = {
      runId: RUN,
      runStatus: "completed",
      reply: {
        conversationId: "55555555-5555-4555-8555-555555555555",
        text: "Three runs are live.",
      },
    };
    expect(assistantReplyGet.output.parse(answered)).toEqual(answered);
    const running = { runId: RUN, runStatus: "running", reply: null };
    expect(assistantReplyGet.output.parse(running)).toEqual(running);
    expect(
      assistantReplyGet.output.safeParse({ ...running, runStatus: "sealed" })
        .success,
    ).toBe(false);
  });
});
