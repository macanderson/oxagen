import { describe, expect, it } from "vitest";
import {
  agentInterjectionList,
  interjectionListItem,
} from "./agent.interjection.list";

const open = {
  id: "inj_0123456789abcdefghjkmn",
  runId: "tse_4q8r1t6v3x5z0b2d7h2k9m",
  agentKey: "acme.core.cc-laptop",
  question: "Which branch should I push to?",
  raisedAt: "2026-09-25T10:00:00.000Z",
  expiresAt: "2026-09-25T10:15:00.000Z",
  answeredAt: null,
  answer: null,
  answeredBy: null,
};

describe("list_interjections contract", () => {
  it("is a console read: mutates false, noBillingGate true, scoped, default-deny", () => {
    expect(agentInterjectionList.mutates).toBe(false);
    expect(agentInterjectionList.noBillingGate).toBe(true);
    expect(agentInterjectionList.scoped).toBe(true);
    expect(agentInterjectionList.defaultEffect).toBe("deny");
    expect(agentInterjectionList.surfaces).toEqual(["api", "mcp", "agent"]);
  });

  it("lists open questions by default, fifty to a page", () => {
    expect(agentInterjectionList.input.parse({})).toEqual({
      open: true,
      limit: 50,
    });
  });

  it("refuses a page size outside 1..100 and an unknown key (negative)", () => {
    for (const input of [{ limit: 0 }, { limit: 101 }, { kinds: [] }]) {
      expect(agentInterjectionList.input.safeParse(input).success).toBe(false);
    }
  });

  it("carries an open question and an answered one", () => {
    const answered = {
      ...open,
      answeredAt: "2026-09-25T10:05:00.000Z",
      answer: "Push to fix/billing.",
      answeredBy: "usr_0123456789abcdefghjkmn",
    };
    const page = { items: [open, answered], nextCursor: null };
    expect(agentInterjectionList.output.parse(page)).toEqual(page);
  });

  it("refuses an id that is not an interjection's and a run neither store mints (negative)", () => {
    expect(
      interjectionListItem.safeParse({ ...open, id: "apr_0123" }).success,
    ).toBe(false);
    expect(
      interjectionListItem.safeParse({ ...open, runId: "run_0123" }).success,
    ).toBe(false);
    expect(
      interjectionListItem.safeParse({ ...open, question: "" }).success,
    ).toBe(false);
  });
});
