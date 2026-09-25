import { describe, expect, it } from "vitest";
import { assistantAsk } from "./assistant.ask";
import { assistantTurnCancel } from "./assistant.turn.cancel";

const TURN = "0192d4a8-7c1e-7a00-8000-0000000000f1";

describe("cancel_assistant_turn contract (#4164)", () => {
  it("is a scoped control on the API that changes a turn and spends nothing", () => {
    expect(assistantTurnCancel.surfaces).toEqual(["api"]);
    expect(assistantTurnCancel.mode).toBe("sync");
    expect(assistantTurnCancel.scoped).toBe(true);
    expect(assistantTurnCancel.mutates).toBe(true);
    expect(assistantTurnCancel.noBillingGate).toBe(true);
    expect(assistantTurnCancel.defaultEffect).toBe("deny");
  });

  it("names the turn by the uuid its caller minted, and nothing else (negative)", () => {
    expect(assistantTurnCancel.input.parse({ turnId: TURN })).toEqual({
      turnId: TURN,
    });
    expect(assistantTurnCancel.input.safeParse({ turnId: "t1" }).success).toBe(
      false,
    );
    expect(assistantTurnCancel.input.safeParse({}).success).toBe(false);
    // The caller cannot name another person's turn by adding a user.
    expect(
      assistantTurnCancel.input.safeParse({ turnId: TURN, userId: TURN })
        .success,
    ).toBe(false);
  });

  it("answers whether a running turn took the stop", () => {
    expect(
      assistantTurnCancel.output.parse({ turnId: TURN, found: false }),
    ).toEqual({ turnId: TURN, found: false });
    expect(assistantTurnCancel.output.safeParse({ turnId: TURN }).success).toBe(
      false,
    );
  });
});

describe("ask_assistant's side of the stop (#4164)", () => {
  it("takes an optional uuid turnId and refuses any other shape (negative)", () => {
    expect(
      assistantAsk.input.parse({ content: "hi", turnId: TURN }).turnId,
    ).toBe(TURN);
    expect(assistantAsk.input.parse({ content: "hi" }).turnId).toBeUndefined();
    expect(
      assistantAsk.input.safeParse({ content: "hi", turnId: "t1" }).success,
    ).toBe(false);
  });

  it("marks a stopped turn, and reads an answer without the mark as not stopped", () => {
    const answer = {
      conversationId: "0192d4a8-7c1e-7a00-8000-0000000000c1",
      conversationPublicId: "cnv_01k9x2tq",
      userMessageId: "0192d4a8-7c1e-7a00-8000-0000000000a1",
      assistantMessageId: "0192d4a8-7c1e-7a00-8000-0000000000a2",
      runId: "arun_01k9",
      reply: "Two agents are",
      parkedCards: [],
    };
    expect(assistantAsk.output.parse(answer).stopped).toBe(false);
    expect(
      assistantAsk.output.parse({ ...answer, stopped: true }).stopped,
    ).toBe(true);
  });
});
