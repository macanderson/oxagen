import { describe, expect, it } from "vitest";
import {
  canSummarizeRun,
  RUN_LIST_TOTAL_BOUND,
  RUN_REPLAY_FILTERS,
  runItemSchema,
  runList,
} from "./run.list";

const item = {
  id: "tse_4q8r1t6v3x5z0b2d7h2k9m",
  source: "tacho",
  agentKey: "acme.core.cc-laptop",
  operatorId: null,
  operatorKind: null,
  operatorName: null,
  operatorAttribution: null,
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
  endedAt: "2026-09-08T10:06:29.000Z",
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

  it("is a low-risk read the in-app agent may call without approval", () => {
    expect(runList.surfaces).toEqual(["api", "mcp", "agent", "cli"]);
    expect(runList.layers).toContain("cli");
    expect(runList.agent).toEqual({
      requiresApproval: false,
      riskLevel: "low",
      category: "run",
    });
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

describe("list_runs tokens, cache hit rate and compaction (#3834, #3835)", () => {
  const tokens = {
    input_uncached: 1200,
    cache_read: 48_000,
    cache_write_5m: 3000,
    cache_write_1h: 0,
    output: 900,
    reasoning: 0,
  };

  it("carries the rollup's token counts and cache hit rate, or null for a run with no rollup row", () => {
    const priced = { ...item, tokens, cacheHitRate: 0.97, compacted: true };
    expect(runItemSchema.parse(priced)).toEqual(priced);
    const unpriced = { ...item, tokens: null, cacheHitRate: null };
    expect(runItemSchema.parse(unpriced)).toEqual(unpriced);
    expect(runItemSchema.parse(item)).toEqual(item);
  });

  it("refuses a rate outside 0..1 and a token class the rollup does not keep (negative)", () => {
    expect(
      runItemSchema.safeParse({ ...item, cacheHitRate: 1.2 }).success,
    ).toBe(false);
    expect(
      runItemSchema.safeParse({ ...item, tokens: { ...tokens, extra: 1 } })
        .success,
    ).toBe(false);
  });

  it("keeps paused and compacted out of the status (ADR-190, negative)", () => {
    expect(runItemSchema.safeParse({ ...item, status: "paused" }).success).toBe(
      false,
    );
    expect(
      runItemSchema.safeParse({ ...item, status: "compacted" }).success,
    ).toBe(false);
  });
});

describe("list_runs pull request state (#4129)", () => {
  it("carries when the state was last read, or null when it never was", () => {
    const row = {
      ...item,
      pullRequests: [
        {
          url: "https://github.com/acme/api/pull/7",
          number: 7,
          repository: "acme/api",
          state: "merged",
          stateSeenAt: "2026-09-25T10:00:00.000Z",
        },
        {
          url: "https://github.com/acme/api/pull/8",
          number: 8,
          repository: "acme/api",
          state: null,
          stateSeenAt: null,
        },
      ],
    };
    expect(runItemSchema.parse(row)).toEqual(row);
  });
});

describe("list_runs filters, search, sort and total (#3837)", () => {
  it("lists exactly as before when a call sends none of them", () => {
    expect(runList.input.parse({ limit: 25 })).toEqual({ limit: 25 });
  });

  it("accepts every filter, the search, a sort and an offset", () => {
    const input = {
      limit: 25,
      status: ["live", "halted"],
      tier: ["gateway", "observe"],
      replayGrade: ["fork", "not_recorded"],
      query: "  mac-studio  ",
      sort: { key: "cost", dir: "asc" },
      offset: 50,
    };
    expect(runList.input.parse(input)).toEqual({
      ...input,
      query: "mac-studio",
    });
    expect(RUN_REPLAY_FILTERS).toContain("not_recorded");
  });

  it("refuses an empty filter, a paused status, an unknown sort key and an offset past the bound (negative)", () => {
    const bad = [
      { status: [] },
      { status: ["paused"] },
      { tier: ["cloud"] },
      { replayGrade: ["replay"] },
      { query: "   " },
      { sort: { key: "tokens", dir: "asc" } },
      { sort: { key: "cost", dir: "up" } },
      { offset: -1 },
      { offset: RUN_LIST_TOTAL_BOUND + 1 },
    ];
    for (const input of bad) {
      expect(runList.input.safeParse(input).success).toBe(false);
    }
  });

  it("carries a bounded total, null past the bound, or none when not counted", () => {
    const base = { runs: [], nextCursor: null };
    expect(runList.output.parse(base)).toEqual(base);
    const counted = { ...base, total: 42, totalBound: RUN_LIST_TOTAL_BOUND };
    expect(runList.output.parse(counted)).toEqual(counted);
    const past = { ...base, total: null, totalBound: RUN_LIST_TOTAL_BOUND };
    expect(runList.output.parse(past)).toEqual(past);
    expect(runList.output.safeParse({ ...base, total: -1 }).success).toBe(
      false,
    );
  });
});
