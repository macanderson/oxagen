import { describe, expect, it } from "vitest";
import { canSummarizeRun, runItemSchema, runList } from "./run.list";

const item = {
  id: "tse_4q8r1t6v3x5z0b2d7h2k9m",
  source: "tacho",
  agentKey: "acme.core.cc-laptop",
  operatorId: null,
  operatorKind: null,
  operatorName: null,
  status: "sealed",
  outcome: "completed",
  turns: 2,
  steps: 7,
  frames: 207,
  cost: null,
  model: null,
  machine: null,
  taskRef: null,
  startedAt: "2026-09-08T10:06:03.000Z",
  sealedAt: "2026-09-08T10:06:30.000Z",
  replayGrade: null,
  verdict: null,
  enforcementTier: "observe",
  completenessGaps: [],
  canSummarize: true,
  name: null,
  summary: null,
};

describe("list_runs run row: who ran it, on what, with which model", () => {
  it("carries a named person, a model and a machine", () => {
    const full = {
      ...item,
      operatorId: "prn_0123456789abcdefghjkmn",
      operatorKind: "human",
      operatorName: "Marcus Bell",
      model: {
        id: "claude-sonnet-5",
        provider: "anthropic",
        tier: "sonnet",
      },
      machine: {
        hostname: "mac-studio.local",
        platform: "darwin",
        osVersion: "15.6",
        arch: "arm64",
        nodeVersion: "v24.4.0",
      },
    };
    expect(runItemSchema.parse(full)).toEqual(full);
  });

  it("lets a model name a vendor without naming a class, and a machine omit what enrolment did not record", () => {
    const partial = {
      ...item,
      model: { id: "gpt-5", provider: "openai", tier: null },
      machine: {
        hostname: "runner-14",
        platform: "linux",
        osVersion: null,
        arch: null,
        nodeVersion: null,
      },
    };
    expect(runItemSchema.parse(partial)).toEqual(partial);
  });

  it("refuses a kind outside the principal CHECK and a machine with no hostname (negative)", () => {
    expect(
      runItemSchema.safeParse({ ...item, operatorKind: "robot" }).success,
    ).toBe(false);
    expect(
      runItemSchema.safeParse({
        ...item,
        machine: {
          platform: "darwin",
          osVersion: null,
          arch: null,
          nodeVersion: null,
        },
      }).success,
    ).toBe(false);
  });

  it("refuses a row that leaves the new fields out entirely (negative)", () => {
    const { operatorKind: _k, ...withoutKind } = item;
    expect(runItemSchema.safeParse(withoutKind).success).toBe(false);
    const { model: _m, ...withoutModel } = item;
    expect(runItemSchema.safeParse(withoutModel).success).toBe(false);
  });
});

describe("list_runs contract", () => {
  it("is a console read: mutates false, noBillingGate true, scoped, default-deny", () => {
    expect(runList.mutates).toBe(false);
    expect(runList.noBillingGate).toBe(true);
    expect(runList.scoped).toBe(true);
    expect(runList.defaultEffect).toBe("deny");
    expect(runList.layers).not.toContain("e2e");
  });

  it("defaults the page size and refuses a size outside 1…100 or an unknown key", () => {
    expect(runList.input.parse({})).toEqual({ limit: 50 });
    expect(runList.input.safeParse({ limit: 0 }).success).toBe(false);
    expect(runList.input.safeParse({ limit: 101 }).success).toBe(false);
    expect(runList.input.safeParse({ live: true }).success).toBe(false);
  });

  it("carries a nullable operator and a nullable cost with a required basis", () => {
    expect(runItemSchema.parse(item)).toEqual(item);
    const costed = {
      ...item,
      cost: { micros: "97937", currency: "USD", basis: "client_attested" },
    };
    expect(runItemSchema.parse(costed).cost).toEqual(costed.cost);
    expect(
      runItemSchema.safeParse({
        ...item,
        cost: { micros: "97937", currency: "USD" },
      }).success,
    ).toBe(false);
    expect(
      runItemSchema.safeParse({
        ...item,
        cost: { micros: 97937, currency: "USD", basis: "client_attested" },
      }).success,
    ).toBe(false);
  });

  it("carries the recorded replay grade or null, never a word outside the ladder (negative)", () => {
    for (const replayGrade of ["inspect", "view", "fork", "retry"]) {
      expect(runItemSchema.safeParse({ ...item, replayGrade }).success).toBe(
        true,
      );
    }
    expect(
      runItemSchema.safeParse({ ...item, replayGrade: "replay" }).success,
    ).toBe(false);
    const { replayGrade: _dropped, ...withoutGrade } = item;
    expect(runItemSchema.safeParse(withoutGrade).success).toBe(false);
  });

  it("carries the generated summary with its model and instant, or null", () => {
    const summary = {
      text: "Reviewed the PR and left two comments.",
      generatedAt: "2026-09-08T10:07:00.000Z",
      model: "anthropic/claude-haiku-4.5",
    };
    expect(
      runItemSchema.parse({ ...item, name: "Review PR 42", summary }).summary,
    ).toEqual(summary);
    expect(
      runItemSchema.safeParse({ ...item, summary: { text: "x" } }).success,
    ).toBe(false);
  });

  it("refuses an id neither store mints and a status outside the three", () => {
    expect(runItemSchema.safeParse({ ...item, id: "run_abc" }).success).toBe(
      false,
    );
    expect(
      runItemSchema.safeParse({ ...item, status: "running" }).success,
    ).toBe(false);
  });
});

describe("list_runs verdict (ADR-064)", () => {
  it("carries each witness verdict word or null, and refuses any other word (negative)", () => {
    for (const verdict of [
      null,
      "flipped",
      "failing",
      "unmoved",
      "unsatisfied",
      "tampered",
      "unverified",
      "waived",
    ])
      expect(runItemSchema.safeParse({ ...item, verdict }).success).toBe(true);
    expect(runItemSchema.safeParse({ ...item, verdict: "none" }).success).toBe(
      false,
    );
    expect(
      runItemSchema.safeParse({ ...item, verdict: "proven" }).success,
    ).toBe(false);
    const { verdict: _dropped, ...withoutVerdict } = item;
    expect(runItemSchema.safeParse(withoutVerdict).success).toBe(false);
  });
});

describe("the row a caller decides from (#3285)", () => {
  it("names the tier the run was observed at, from a closed set (negative)", () => {
    for (const enforcementTier of ["gateway", "harness", "observe"]) {
      expect(
        runItemSchema.safeParse({ ...item, enforcementTier }).success,
      ).toBe(true);
    }
    expect(
      runItemSchema.safeParse({ ...item, enforcementTier: "proxy" }).success,
    ).toBe(false);
    // The tier is how a caller knows whether a control has a connection point
    // to reach, so it is never absent.
    const { enforcementTier: _omit, ...without } = item;
    expect(runItemSchema.safeParse(without).success).toBe(false);
  });

  it("publishes gaps from the closed vocabulary only (negative)", () => {
    expect(
      runItemSchema.safeParse({
        ...item,
        completenessGaps: ["digest_only", "tool_bodies"],
      }).success,
    ).toBe(true);
    expect(
      runItemSchema.safeParse({ ...item, completenessGaps: ["something_new"] })
        .success,
    ).toBe(false);
  });
});

describe("canSummarizeRun", () => {
  it("refuses a live run: the record is not yet complete", () => {
    expect(canSummarizeRun({ status: "live", completenessGaps: [] })).toBe(
      false,
    );
  });

  it("refuses a digest_only recording: there are no bodies for a model to read", () => {
    expect(
      canSummarizeRun({ status: "sealed", completenessGaps: ["digest_only"] }),
    ).toBe(false);
  });

  it("allows a sealed recording that kept bodies, halted or not", () => {
    expect(canSummarizeRun({ status: "sealed", completenessGaps: [] })).toBe(
      true,
    );
    expect(
      canSummarizeRun({ status: "halted", completenessGaps: ["tool_bodies"] }),
    ).toBe(true);
  });
});

// The outcome, beside the status. `status` has three words and the stores
// record five and five, so a row that carried only the status could not say
// whether a sealed run finished or failed.
describe("run outcome", () => {
  it("carries every word either store records", () => {
    for (const outcome of [
      "running",
      "completed",
      "failed",
      "cancelled",
      "crashed",
      "unknown",
    ]) {
      expect(runItemSchema.safeParse({ ...item, outcome }).success).toBe(true);
    }
  });

  it("refuses a word neither store records (negative)", () => {
    for (const outcome of ["sealed", "aborted", "pending", "abandoned"]) {
      expect(runItemSchema.safeParse({ ...item, outcome }).success).toBe(false);
    }
  });

  it("requires one: a row with no outcome is a row that cannot say how the run ended (negative)", () => {
    const { outcome: _dropped, ...without } = item;
    expect(runItemSchema.safeParse(without).success).toBe(false);
  });

  it("separates a run that finished from one that failed, which the status cannot", () => {
    const completed = runItemSchema.parse({ ...item, outcome: "completed" });
    const failed = runItemSchema.parse({ ...item, outcome: "failed" });
    expect(completed.status).toBe(failed.status);
    expect(completed.outcome).not.toBe(failed.outcome);
  });
});
