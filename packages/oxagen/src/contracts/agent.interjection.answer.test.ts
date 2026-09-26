import { describe, expect, it } from "vitest";
import {
  agentInterjectionAnswer,
  INTERJECTION_ANSWER_MAX,
  isInterjectionPublicId,
} from "./agent.interjection.answer";

describe("answer_interjection contract", () => {
  it("is a person's write that never bills and never reaches the agent surface (ADR-175)", () => {
    expect(agentInterjectionAnswer.mutates).toBe(true);
    expect(agentInterjectionAnswer.noBillingGate).toBe(true);
    expect(agentInterjectionAnswer.scoped).toBe(true);
    expect(agentInterjectionAnswer.surfaces).toEqual(["api", "mcp", "cli"]);
    expect(agentInterjectionAnswer.layers).not.toContain("app");
  });

  it("accepts a public id or a row uuid, and trims the answer", () => {
    expect(
      agentInterjectionAnswer.input.parse({
        interjectionId: "inj_0123456789abcdefghjkmn",
        answer: "  Push to fix/billing.  ",
      }),
    ).toEqual({
      interjectionId: "inj_0123456789abcdefghjkmn",
      answer: "Push to fix/billing.",
    });
    expect(
      agentInterjectionAnswer.input.safeParse({
        interjectionId: "0199a3f1-6c2e-7b3a-9f10-2d4c5e6f7a8b",
        answer: "yes",
      }).success,
    ).toBe(true);
    expect(isInterjectionPublicId("inj_0123")).toBe(true);
    expect(isInterjectionPublicId("0199a3f1-6c2e-7b3a-9f10-2d4c5e6f7a8b")).toBe(
      false,
    );
  });

  it("refuses another record's id, a blank answer and one past the limit (negative)", () => {
    const bad = [
      { interjectionId: "apr_0123", answer: "yes" },
      { interjectionId: "inj_0123", answer: "   " },
      {
        interjectionId: "inj_0123",
        answer: "x".repeat(INTERJECTION_ANSWER_MAX + 1),
      },
      { interjectionId: "inj_0123", answer: "yes", runId: "tse_1" },
    ];
    for (const input of bad) {
      expect(agentInterjectionAnswer.input.safeParse(input).success).toBe(
        false,
      );
    }
  });

  it("answers the queued message command, or none for a run no host can reach", () => {
    const queued = {
      interjectionId: "inj_0123",
      runId: "tse_4q8r1t6v3x5z0b2d7h2k9m",
      answeredAt: "2026-09-25T10:05:00.000Z",
      commandIds: ["tcm_0123"],
      receiptId: "rcp_0123",
      path: null,
      repository: null,
      workspace: null,
    };
    expect(agentInterjectionAnswer.output.parse(queued)).toEqual(queued);
    const ledger = { ...queued, runId: "arun_7k2", commandIds: [] };
    expect(agentInterjectionAnswer.output.parse(ledger)).toEqual(ledger);
  });
});
