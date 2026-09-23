import { describe, expect, it, vi } from "vitest";
import type { ToolCallObservationRow } from "@oxagen/telemetry";

vi.mock("@oxagen/database", () => ({
  schema: {},
  withSystemDb: vi.fn(() => {
    throw new Error("the pass must not reach the database in this test");
  }),
}));
vi.mock("@oxagen/telemetry", () => ({
  readTachoToolCallObservations: vi.fn(),
}));

import { ZERO_TOKENS, type RunTotalsRecord } from "./cost-rollup";
import type { FindingDraft } from "./findings";
import {
  runFindingsPass,
  TOOL_CALL_READ_MAX,
  toolWindowStart,
  toObservations,
  undecidedDrafts,
} from "./findings-store";

const SCOPE = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};
const NOW = new Date("2026-09-15T00:00:00.000Z");
const WINDOW_START = new Date("2026-08-16T00:00:00.000Z");
const SESSION = "00000000-0000-4000-8000-0000000000aa";
const RUN_ID = "tse_0000000000000000000001";

function row(
  over: Partial<ToolCallObservationRow> = {},
): ToolCallObservationRow {
  return {
    rootSessionUuid: SESSION,
    at: "2026-09-10T10:00:00.000Z",
    seq: 1,
    tool: "Bash",
    inputDigest: "in",
    outputDigest: "out",
    isMutating: true,
    resultTokens: 5_000,
    ...over,
  };
}

function pricedRun(): RunTotalsRecord {
  return {
    runId: RUN_ID,
    runSource: "tacho",
    ...SCOPE,
    operatorPrincipalId: null,
    operatorKey: null,
    agentPrincipalId: null,
    agentKey: "acme.core.cc",
    taskRef: null,
    costCenter: null,
    startedAt: new Date("2026-09-10T09:59:00.000Z"),
    sealedAt: null,
    turns: 1,
    retries: 0,
    enforcementTier: "harness",
    replayGrade: "view",
    steps: 2,
    modelCalls: 1,
    toolCalls: 2,
    tokens: { ...ZERO_TOKENS, input_uncached: 1_000 },
    costMicros: 3_000n,
    currency: "USD",
    costBasis: "client_attested",
    priceEntryIds: [],
    cacheHitRate: null,
    breakdown: {
      models: [
        {
          model: "claude-sonnet-5",
          provider: "anthropic",
          calls: 1,
          tokens: { ...ZERO_TOKENS, input_uncached: 1_000 },
          costMicros: 3_000n,
          costByClass: {
            input_uncached: 3_000n,
            cache_read: 0n,
            cache_write_5m: 0n,
            cache_write_1h: 0n,
            output: 0n,
            reasoning: 0n,
          },
          basis: "client_attested",
          hasUnpriced: false,
        },
      ],
      tools: [],
    },
    verdict: null,
    accepted: null,
    productiveRatio: null,
  };
}

describe("toolWindowStart", () => {
  it("is the window's start while the read stayed under its cap", () => {
    expect(toolWindowStart(WINDOW_START, [row()], 2)).toEqual(WINDOW_START);
  });

  it("is the oldest call read when the read hit its cap", () => {
    const rows = [
      row({ at: "2026-09-12T00:00:00.000Z" }),
      row({ at: "2026-09-11T00:00:00.000Z" }),
    ];
    expect(toolWindowStart(WINDOW_START, rows, 2)).toEqual(
      new Date("2026-09-11T00:00:00.000Z"),
    );
  });
});

describe("toObservations", () => {
  it("names each call by its root session's run and drops calls of sessions outside the window", () => {
    const out = toObservations(
      [row(), row({ rootSessionUuid: "00000000-0000-4000-8000-0000000000bb" })],
      new Map([[SESSION, RUN_ID]]),
    );
    expect(out).toEqual([
      expect.objectContaining({ runId: RUN_ID, tool: "Bash", seq: 1 }),
    ]);
  });
});

describe("undecidedDrafts", () => {
  const drafts = [
    { fingerprint: "a" },
    { fingerprint: "b" },
    { fingerprint: "c" },
  ] as FindingDraft[];
  const t = (iso: string) => new Date(`2026-09-14T${iso}:00.000Z`);

  it("keeps a draft with no decision, or with only the decision it was detected with", () => {
    expect(
      undecidedDrafts(
        drafts,
        new Map([["a", t("10:00")]]),
        new Map([["a", t("10:00")]]),
      ),
    ).toEqual(drafts);
  });

  it("leaves a fingerprint to a decision the pass did not read, whatever that decision's timestamp", () => {
    const out = undecidedDrafts(
      drafts,
      new Map([
        // Decided before the pass read decisions, committed after it.
        ["a", t("09:00")],
        // Decided again after the decision the pass read.
        ["b", t("11:00")],
      ]),
      new Map([["b", t("10:00")]]),
    );
    expect(out).toEqual([{ fingerprint: "c" }]);
  });
});

describe("runFindingsPass", () => {
  it("reads a thirty-day window, detects over it, and writes at the pass's start", async () => {
    const readToolCalls = vi.fn(async () => [
      row({ seq: 1 }),
      row({ seq: 2, at: "2026-09-10T10:00:01.000Z" }),
    ]);
    const write = vi.fn(
      async (_s, _at, _decided, drafts: readonly FindingDraft[]) =>
        drafts.length,
    );
    const readRuns = vi.fn(async () => [pricedRun()]);
    const readRootSessions = vi.fn(async () => new Map([[SESSION, RUN_ID]]));
    const decisions = new Map<string, Date>();
    const out = await runFindingsPass(SCOPE, {
      now: () => NOW,
      readRuns,
      readRootSessions,
      readToolCalls,
      readDecisions: async () => decisions,
      write,
    });

    expect(readRuns).toHaveBeenCalledWith(SCOPE, {
      start: WINDOW_START,
      end: NOW,
    });
    expect(readRootSessions).toHaveBeenCalledWith(SCOPE, WINDOW_START);
    expect(readToolCalls).toHaveBeenCalledWith({
      ...SCOPE,
      from: WINDOW_START,
      to: NOW,
      limit: TOOL_CALL_READ_MAX,
    });
    expect(out).toEqual({ findings: 1 });
    const [scope, at, decided, drafts] = write.mock.calls[0]!;
    expect(scope).toEqual(SCOPE);
    expect(at).toEqual(NOW);
    expect(decided).toBe(decisions);
    expect(drafts).toEqual([
      expect.objectContaining({
        kind: "repeated_shell_commands",
        citedRuns: [RUN_ID],
        savingMicros: 15_000n,
      }),
    ]);
  });

  it("writes no drafts for a workspace with no runs in the window, so its open findings are deleted", async () => {
    const write = vi.fn(async () => 0);
    await runFindingsPass(SCOPE, {
      now: () => NOW,
      readRuns: async () => [],
      readRootSessions: async () => new Map(),
      readToolCalls: async () => [],
      readDecisions: async () => new Map(),
      write,
    });
    expect(write).toHaveBeenCalledWith(SCOPE, NOW, new Map(), []);
  });

  it("lets a degraded store fail the pass without writing", async () => {
    const write = vi.fn();
    await expect(
      runFindingsPass(SCOPE, {
        now: () => NOW,
        readRuns: async () => [],
        readRootSessions: async () => new Map(),
        readToolCalls: async () => {
          throw new Error("clickhouse down");
        },
        readDecisions: async () => new Map(),
        write,
      }),
    ).rejects.toThrow("clickhouse down");
    expect(write).not.toHaveBeenCalled();
  });
});
