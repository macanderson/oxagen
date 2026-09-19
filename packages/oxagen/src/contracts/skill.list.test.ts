import { describe, expect, it } from "vitest";
import { SKILL_CURSOR_MAX, SKILL_HARNESS_CAP, skillList } from "./skill.list";

const row = {
  name: "release-notes",
  sessions: 3,
  harnesses: ["claude-code"],
  harnessCount: 1,
  firstSeenAt: "2026-09-01T09:00:00.000Z",
  lastSeenAt: "2026-09-14T09:00:00.000Z",
};

const page = {
  window: {
    from: "2026-08-16T00:00:00.000Z",
    to: "2026-09-15T00:00:00.000Z",
  },
  sessions: 5,
  reportedSessions: 4,
  notReportedSessions: 1,
  skills: [row],
  nextCursor: null,
};

describe("list_skills contract", () => {
  it("is an ungated console read", () => {
    expect(skillList.noBillingGate).toBe(true);
    expect(skillList.mutates).toBe(false);
    expect(skillList.scoped).toBe(true);
  });

  it("defaults the window to 30 days and refuses one past 90", () => {
    expect(skillList.input.parse({})).toEqual({ windowDays: 30 });
    expect(skillList.input.safeParse({ windowDays: 90 }).success).toBe(true);
    expect(skillList.input.safeParse({ windowDays: 91 }).success).toBe(false);
    expect(skillList.input.safeParse({ windowDays: 0 }).success).toBe(false);
    expect(skillList.input.safeParse({ limit: 5 }).success).toBe(false);
  });

  it("admits the longest cursor the handler can write", () => {
    // A page whose last name is 512 units that each JSON-escape to `\uXXXX`:
    // the worst case `nextCursor` a page of names can end on.
    const cursor = Buffer.from(
      JSON.stringify([
        "2026-08-16T00:00:00.000Z",
        "2026-09-15T00:00:00.000Z",
        "\u0007".repeat(512),
      ]),
      "utf8",
    ).toString("base64url");
    expect(cursor.length).toBeGreaterThan(1024);
    expect(cursor.length).toBeLessThanOrEqual(SKILL_CURSOR_MAX);
    expect(skillList.input.safeParse({ cursor }).success).toBe(true);
    expect(
      skillList.input.safeParse({ cursor: "a".repeat(SKILL_CURSOR_MAX + 1) })
        .success,
    ).toBe(false);
    expect(skillList.input.safeParse({ cursor: "" }).success).toBe(false);
  });

  it("carries a null reported count when no session reported an inventory", () => {
    expect(skillList.output.parse(page)).toEqual(page);
    expect(
      skillList.output.parse({
        ...page,
        sessions: 2,
        reportedSessions: null,
        notReportedSessions: 2,
        skills: [],
      }).reportedSessions,
    ).toBeNull();
    expect(
      skillList.output.safeParse({ ...page, reportedSessions: 0 }).success,
    ).toBe(false);
  });

  it("refuses a row no session reported, a row with no harness, a non-positive harness count, and a field the record does not carry", () => {
    const withRow = (over: Record<string, unknown>) =>
      skillList.output.safeParse({ ...page, skills: [{ ...row, ...over }] })
        .success;
    expect(withRow({ sessions: 0 })).toBe(false);
    expect(withRow({ harnesses: [] })).toBe(false);
    expect(withRow({ harnessCount: 0 })).toBe(false);
    expect(withRow({ name: "" })).toBe(false);
    expect(withRow({ version: "1.0.0" })).toBe(false);
  });

  it("admits an empty harness label and up to SKILL_HARNESS_CAP harnesses, and refuses one more (#3103)", () => {
    const withRow = (over: Record<string, unknown>) =>
      skillList.output.safeParse({ ...page, skills: [{ ...row, ...over }] })
        .success;
    expect(withRow({ harnesses: [""] })).toBe(true);
    expect(
      withRow({
        harnesses: Array.from(
          { length: SKILL_HARNESS_CAP },
          (_, i) => `harness-${i}`,
        ),
        harnessCount: SKILL_HARNESS_CAP,
      }),
    ).toBe(true);
    expect(
      withRow({
        harnesses: Array.from(
          { length: SKILL_HARNESS_CAP + 1 },
          (_, i) => `harness-${i}`,
        ),
        harnessCount: SKILL_HARNESS_CAP + 1,
      }),
    ).toBe(false);
  });
});
