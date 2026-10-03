import { describe, expect, it } from "vitest";
import {
  FINDINGS_CURSOR_MAX,
  FINDINGS_LIST_MAX,
  findingList,
} from "./finding.list";

const finding = {
  id: "fnd_0123456789abcdefghjkmn",
  kind: "unpaged_results",
  level: "tool",
  subject: "aws_billing__get_cost_and_usage",
  saving: { micros: "984600000", currency: "USD", basis: "gateway_observed" },
  confidence: "high",
  window: { from: "2026-08-16T00:00:00.000Z", to: "2026-09-15T00:00:00.000Z" },
  why: "88 calls returned more than 20,000 result tokens.",
  fix: "Page the results.",
  runs: 88,
  calls: 3106,
  status: "open",
  detectedAt: "2026-09-15T02:00:00.000Z",
  decidedAt: null,
  appliedActionId: null,
};

describe("list_findings contract", () => {
  it("is a console read (INV-28)", () => {
    expect(findingList.noBillingGate).toBe(true);
    expect(findingList.mutates).toBe(false);
  });

  it("lists open findings by default and refuses an unknown status", () => {
    expect(findingList.input.parse({})).toEqual({ status: "open" });
    expect(findingList.input.safeParse({ status: "stale" }).success).toBe(
      false,
    );
  });

  it("carries a saving with its basis and refuses one without", () => {
    const out = {
      status: "open",
      window: finding.window,
      saving: finding.saving,
      spend: { micros: "9000000000", currency: "USD", basis: "mixed" },
      share: 0.11,
      annualised: {
        micros: "11979300000",
        currency: "USD",
        basis: "gateway_observed",
      },
      counts: { findings: 1, high: 1, medium: 0, operators: 2 },
      findings: [finding],
      truncated: false,
      nextCursor: null,
      offset: 0,
    };
    expect(findingList.output.parse(out)).toEqual(out);
    expect(
      findingList.output.safeParse({
        ...out,
        findings: [{ ...finding, saving: { micros: "1", currency: "USD" } }],
      }).success,
    ).toBe(false);
  });

  it("says when the workspace holds more findings than the list (#5262)", () => {
    const out = {
      status: "open",
      window: finding.window,
      saving: finding.saving,
      spend: null,
      share: null,
      annualised: finding.saving,
      counts: {
        findings: FINDINGS_LIST_MAX + 1,
        high: FINDINGS_LIST_MAX + 1,
        medium: 0,
        operators: 0,
      },
      findings: Array.from({ length: FINDINGS_LIST_MAX }, () => finding),
      truncated: true,
      nextCursor: "eyJ9",
      offset: 0,
    };
    expect(findingList.output.parse(out)).toEqual(out);
    // An answer must say whether the list was cut, and lists at most 50.
    const unsaid = Object.fromEntries(
      Object.entries(out).filter(([key]) => key !== "truncated"),
    );
    expect(findingList.output.safeParse(unsaid).success).toBe(false);
    expect(
      findingList.output.safeParse({
        ...out,
        findings: [...out.findings, finding],
      }).success,
    ).toBe(false);
  });

  it("narrows to one run and carries what each finding cites there (#4001)", () => {
    expect(findingList.surfaces).toEqual(["api", "mcp", "agent", "cli"]);
    expect(findingList.input.parse({ runId: "tse_4q8r1t6v" })).toEqual({
      status: "open",
      runId: "tse_4q8r1t6v",
    });
    expect(findingList.input.safeParse({ runId: "run_1" }).success).toBe(
      false,
    );
    const cited = {
      ...finding,
      citation: {
        runId: "tse_4q8r1t6v",
        runLevel: false,
        frames: [
          { seq: "12" },
          { seq: "40", sessionUuid: "3f6c0b1e-9a3d-4c2b-8e57-0d1f2a3b4c5d" },
        ],
        framesTotal: 2,
      },
    };
    const out = {
      status: "open",
      window: finding.window,
      saving: finding.saving,
      spend: null,
      share: null,
      annualised: finding.saving,
      counts: { findings: 1, high: 1, medium: 0, operators: 0 },
      findings: [cited],
      truncated: false,
      nextCursor: null,
      offset: 0,
    };
    expect(findingList.output.parse(out)).toEqual(out);
    // A run-level finding pins no frame, and an older row names none (null).
    for (const citation of [
      { ...cited.citation, runLevel: true, frames: [] },
      { ...cited.citation, frames: null, framesTotal: 0 },
    ])
      expect(
        findingList.output.safeParse({
          ...out,
          findings: [{ ...finding, citation }],
        }).success,
      ).toBe(true);
    // A seq that is not a sequence, and more frames than the cap (negative).
    for (const frames of [
      [{ seq: "tse_1" }],
      Array.from({ length: 51 }, (_, i) => ({ seq: String(i) })),
    ])
      expect(
        findingList.output.safeParse({
          ...out,
          findings: [{ ...finding, citation: { ...cited.citation, frames } }],
        }).success,
      ).toBe(false);
  });

  it("takes a cursor, a level and a subject, and answers the next page's cursor and the page's offset (#5303)", () => {
    expect(
      findingList.input.parse({
        level: "agent",
        subject: "acme.core.release-bot",
        cursor: "WyJvcGVuIl0",
      }),
    ).toEqual({
      status: "open",
      level: "agent",
      subject: "acme.core.release-bot",
      cursor: "WyJvcGVuIl0",
    });
    // A level the findings job never writes, an empty subject or cursor, and
    // a cursor past the bound (negative).
    for (const bad of [
      { level: "run" },
      { subject: "" },
      { cursor: "" },
      { cursor: "x".repeat(FINDINGS_CURSOR_MAX + 1) },
    ])
      expect(findingList.input.safeParse(bad).success).toBe(false);

    const out = {
      status: "open",
      window: finding.window,
      saving: finding.saving,
      spend: null,
      share: null,
      annualised: finding.saving,
      counts: { findings: 62, high: 62, medium: 0, operators: 0 },
      findings: Array.from({ length: 12 }, () => finding),
      truncated: true,
      nextCursor: null,
      offset: FINDINGS_LIST_MAX,
    };
    expect(findingList.output.parse(out)).toEqual(out);
    // Every answer says where its page starts and whether another follows.
    for (const key of ["nextCursor", "offset"])
      expect(
        findingList.output.safeParse(
          Object.fromEntries(Object.entries(out).filter(([k]) => k !== key)),
        ).success,
      ).toBe(false);
    expect(findingList.output.safeParse({ ...out, offset: -1 }).success).toBe(
      false,
    );
  });

  it("refuses a finding that cites no run", () => {
    expect(
      findingList.output.safeParse({
        status: "open",
        window: null,
        saving: null,
        spend: null,
        share: null,
        annualised: null,
        counts: { findings: 1, high: 1, medium: 0, operators: 0 },
        findings: [{ ...finding, runs: 0 }],
        truncated: false,
        nextCursor: null,
        offset: 0,
      }).success,
    ).toBe(false);
  });
});
