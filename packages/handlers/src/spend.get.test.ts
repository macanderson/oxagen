import {
  ASSISTANT_SPEND_KEY,
  NO_WORK_ITEM_KEY,
  spendGet,
} from "@oxagen/oxagen/contracts/spend.get";
import type { OperatorFacts } from "@oxagen/oxagen/contracts/operator.shared";
import type { UnmeteredRuns } from "@oxagen/oxagen/contracts/spend.shared";
import { describe, expect, it, vi } from "vitest";
import {
  compareRows,
  createSpendGetHandler,
  groupRows,
  mcpServerOf,
  mcpServerShares,
  observedSpend,
  promptComposition,
  reportedSpend,
} from "./spend.get";
import {
  type RunWorkItem,
  type RunWorkOrderRef,
  workOrderKey,
} from "./lib/run-work-items";
import type { SpendRunRecord } from "./spend.shared";
import {
  daily,
  ctx,
  OPERATOR,
  pricedRun,
  run,
  SCOPE,
} from "./spend.test-support";

const OTHER = "0192d4a8-7c1e-7a00-8000-0000000000b2";
const PERIOD = { from: "2026-09-01", to: "2026-09-30" };

function harness(
  over: {
    daily?: ReturnType<typeof daily>[];
    runs?: SpendRunRecord[];
    unmetered?: UnmeteredRuns;
    names?: Record<string, string>;
    harnesses?: Record<string, string>;
    /** The harness each agent registered, by agent key; absent leaves the dep out. */
    agentHarnesses?: Record<string, string>;
    /** The people operator keys name; absent leaves the dep out. */
    people?: OperatorFacts[];
    /** The work item each work order served; absent leaves the dep out. */
    workItems?: [RunWorkOrderRef, RunWorkItem][];
  } = {},
) {
  const readDailyTotals = vi.fn(async () => over.daily ?? []);
  const readRunTotals = vi.fn(async () => over.runs ?? []);
  const readUnmeteredRuns = vi.fn(
    async (): Promise<UnmeteredRuns> =>
      over.unmetered ?? { total: 0, byHarness: [] },
  );
  const readRunNames = vi.fn(
    async (_scope: unknown, runIds: readonly string[]) =>
      new Map(
        runIds.map((id): [string, string | null] => [
          id,
          over.names?.[id] ?? null,
        ]),
      ),
  );
  const readRunHarnesses = vi.fn(
    async () => new Map(Object.entries(over.harnesses ?? {})),
  );
  const agentHarnesses = over.agentHarnesses;
  const readAgentHarnesses = vi.fn(
    async () => new Map(Object.entries(agentHarnesses ?? {})),
  );
  const people = over.people;
  const readOperatorFacts = vi.fn(
    async (_scope: unknown, keys: readonly string[]) =>
      new Map(
        (people ?? [])
          .filter((person) => keys.includes(person.id))
          .map((person): [string, OperatorFacts] => [person.id, person]),
      ),
  );
  const workItems = over.workItems;
  const readRunWorkItems = vi.fn(
    async (_scope: unknown, orders: readonly RunWorkOrderRef[]) => {
      const wanted = new Set(orders.map((order) => workOrderKey(order)));
      return new Map(
        (workItems ?? [])
          .map(([order, item]): [string, RunWorkItem] => [
            workOrderKey(order),
            item,
          ])
          .filter(([key]) => wanted.has(key)),
      );
    },
  );
  const handler = createSpendGetHandler({
    readDailyTotals,
    readRunTotals,
    readUnmeteredRuns,
    readRunNames,
    readRunHarnesses,
    ...(agentHarnesses === undefined ? {} : { readAgentHarnesses }),
    ...(people === undefined ? {} : { readOperatorFacts }),
    ...(workItems === undefined ? {} : { readRunWorkItems }),
  });
  return {
    handler,
    readDailyTotals,
    readRunTotals,
    readUnmeteredRuns,
    readRunNames,
    readRunHarnesses,
    readAgentHarnesses,
    readOperatorFacts,
    readRunWorkItems,
  };
}

describe("get_spend, runs with no usage (#3304)", () => {
  it("says how many of the period's runs reported no usage, by harness, beside a total that leaves them out", async () => {
    // A Codex run with its own base URL and a Cursor run record tool calls
    // and no model usage; a Claude Code run beside them is priced. The total
    // counts all three runs and can only price one.
    const unmetered: UnmeteredRuns = {
      total: 2,
      byHarness: [
        { harness: "codex", runs: 1 },
        { harness: "cursor", runs: 1 },
      ],
    };
    const h = harness({
      runs: [
        run({ modelCalls: 0, steps: 3 }),
        run({ modelCalls: 0, steps: 2 }),
        pricedRun(4_500n),
      ],
      unmetered,
    });
    const out = await h.handler({ period: PERIOD, groupBy: "model" }, ctx());
    expect(h.readUnmeteredRuns).toHaveBeenCalledWith(SCOPE, PERIOD);
    expect(out.unmeteredRuns).toEqual(unmetered);
    expect(out.total.runs).toBe(3);
    expect(out.total.cost?.micros).toBe("4500");
    expect(() => spendGet.output.parse(out)).not.toThrow();
  });

  it("answers zero when every run reported usage", async () => {
    const h = harness({ runs: [pricedRun(4_500n)] });
    const out = await h.handler({ period: PERIOD, groupBy: "model" }, ctx());
    expect(out.unmeteredRuns).toEqual({ total: 0, byHarness: [] });
  });
});

describe("get_spend", () => {
  it("reads the level's day rows and every run row for the caller's workspace and period", async () => {
    const h = harness();
    await h.handler({ period: PERIOD, groupBy: "agent" }, ctx());
    expect(h.readDailyTotals).toHaveBeenCalledWith(SCOPE, {
      ...PERIOD,
      groupKind: "agent",
    });
    expect(h.readRunTotals).toHaveBeenCalledWith(SCOPE, PERIOD);
  });

  it("answers null money and empty rows for a period with no rollup, never a zero", async () => {
    const h = harness();
    const out = await h.handler({ period: PERIOD, groupBy: "operator" }, ctx());
    expect(out.rows).toEqual([]);
    expect(out.total).toEqual({
      cost: null,
      calls: 0,
      runs: 0,
      proven: null,
      accepted: null,
      productiveRatio: null,
    });
    expect(() => spendGet.output.parse(out)).not.toThrow();
  });

  it("sums a key's days into one row with the basis folded and the tokens added", async () => {
    const h = harness({
      daily: [
        daily({
          day: "2026-09-10",
          costMicros: 1_500n,
          costBasis: "client_attested",
          calls: 4,
          tokens: { ...daily().tokens, input_uncached: 100 },
        }),
        daily({
          day: "2026-09-11",
          costMicros: 500n,
          costBasis: "gateway_observed",
          calls: 2,
          tokens: { ...daily().tokens, input_uncached: 50 },
        }),
        daily({ day: "2026-09-12", groupKey: OTHER, runs: 3, calls: 9 }),
      ],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "operator" }, ctx());
    expect(out.rows).toHaveLength(2);
    const [priced, unpriced] = out.rows;
    expect(priced).toMatchObject({
      key: OPERATOR,
      cost: { micros: "2000", currency: "USD", basis: "mixed" },
      calls: 6,
      runs: 2,
      tokens: expect.objectContaining({ input_uncached: 150 }),
    });
    // A key no frame priced answers null, and sorts after the priced keys.
    expect(unpriced).toMatchObject({
      key: OTHER,
      cost: null,
      runs: 3,
      calls: 9,
    });
    expect(() => spendGet.output.parse(out)).not.toThrow();
  });

  it("keeps proven and accepted apart from cost and from each other", async () => {
    const h = harness({
      daily: [
        daily({
          costMicros: 900n,
          costBasis: "client_attested",
          provenMicros: 300n,
          acceptedMicros: null,
        }),
        daily({
          day: "2026-09-11",
          costMicros: 100n,
          costBasis: "client_attested",
          provenMicros: 0n,
          acceptedMicros: 100n,
        }),
      ],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "operator" }, ctx());
    expect(out.rows[0]?.proven).toEqual({ micros: "300", currency: "USD" });
    expect(out.rows[0]?.accepted).toEqual({ micros: "100", currency: "USD" });
    expect(out.rows[0]?.cost?.micros).toBe("1000");
  });

  it("totals the period over the run rows, so a run with no operator still counts", async () => {
    const h = harness({
      daily: [daily({ costMicros: 700n, costBasis: "client_attested" })],
      runs: [
        pricedRun(700n),
        pricedRun(300n, {
          operatorPrincipalId: null,
          operatorKey: null,
          verdict: "flipped",
        }),
        run({ verdict: "failing" }),
      ],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "operator" }, ctx());
    expect(out.total.runs).toBe(3);
    expect(out.total.cost).toEqual({
      micros: "1000",
      currency: "USD",
      basis: "client_attested",
    });
    // Two runs carry a verdict; only the flipped, priced one adds to proven.
    expect(out.total.proven).toEqual({ micros: "300", currency: "USD" });
    expect(out.total.accepted).toBeNull();
  });

  it("marks the total estimated when any run in it is", async () => {
    const h = harness({
      runs: [pricedRun(10n), pricedRun(5n, { costBasis: "estimated" })],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "model" }, ctx());
    expect(out.total.cost?.basis).toBe("estimated");
  });
});

describe("groupRows and compareRows", () => {
  it("orders largest spend first, unpriced keys after priced ones, ties by key", () => {
    const rows = groupRows([
      daily({ groupKey: "b", costMicros: 10n, costBasis: "client_attested" }),
      daily({ groupKey: "a", costMicros: 10n, costBasis: "client_attested" }),
      daily({ groupKey: "z" }),
      daily({ groupKey: "c", costMicros: 40n, costBasis: "client_attested" }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(["c", "a", "b", "z"]);
    expect([...rows].sort(compareRows).map((r) => r.key)).toEqual(
      rows.map((r) => r.key),
    );
  });

  it("keeps a model row's provider", () => {
    const rows = groupRows([
      daily({
        groupKind: "model",
        groupKey: "claude-sonnet-5",
        provider: null,
      }),
      daily({
        groupKind: "model",
        groupKey: "claude-sonnet-5",
        day: "2026-09-11",
        provider: "anthropic",
      }),
    ]);
    expect(rows[0]?.provider).toBe("anthropic");
  });
});

describe("get_spend open runs (#3980)", () => {
  it("counts the period's runs whose cost is still a running estimate", async () => {
    const h = harness({
      runs: [
        pricedRun(1_000n),
        pricedRun(400n, { sealedAt: null }),
        run({ sealedAt: null }),
      ],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "agent" }, ctx());
    // The open run nothing priced adds no figure, so it is not one of them.
    expect(out.estimatedRuns).toBe(1);
    // The open run's cost is in the total, as the estimate it is.
    expect(out.total.cost).toEqual({
      micros: "1400",
      currency: "USD",
      basis: "client_attested",
    });
    expect(() => spendGet.output.parse(out)).not.toThrow();
  });

  it("counts none when every run has sealed", async () => {
    const h = harness({ runs: [pricedRun(10n)] });
    const out = await h.handler({ period: PERIOD, groupBy: "agent" }, ctx());
    expect(out.estimatedRuns).toBe(0);
  });
});

/** A priced run that called MCP tools, each tool's result estimate given. */
function mcpRun(
  micros: bigint,
  tools: { name: string; calls: number; costMicros: bigint | null }[],
  over: Parameters<typeof pricedRun>[1] = {},
) {
  const base = pricedRun(micros, over);
  return {
    ...base,
    breakdown: {
      ...base.breakdown,
      tools: tools.map((t) => ({
        ...t,
        resultTokens: t.costMicros === null ? null : 100,
      })),
    },
  };
}

describe("get_spend by MCP server", () => {
  it("parses the server out of a tool name, after the harness prefix", () => {
    expect(mcpServerOf("mcp__github__create_issue")).toBe("github");
    expect(mcpServerOf("claude_code__mcp__linear__list_issues")).toBe(
      "linear",
    );
    expect(mcpServerOf("mcp__my_server__search")).toBe("my_server");
    expect(mcpServerOf("Read")).toBeNull();
    expect(mcpServerOf("mcp__github")).toBeNull();
  });

  it("gives each server its tools' estimate and the rest of the run to Everything else", () => {
    const shares = mcpServerShares(
      mcpRun(1_000n, [
        { name: "mcp__github__create_issue", calls: 2, costMicros: 150n },
        { name: "mcp__github__get_file", calls: 1, costMicros: 50n },
        { name: "mcp__linear__list_issues", calls: 1, costMicros: 100n },
        { name: "Read", calls: 3, costMicros: 20n },
      ]),
    );
    expect(shares.map((s) => [s.key, s.micros, s.basis, s.calls])).toEqual([
      ["github", 200n, "estimated", 3],
      ["linear", 100n, "estimated", 1],
      ["~other", 700n, "estimated", 0],
    ]);
  });

  it("leaves a run with no priced server tool whole under Everything else, at its own basis", () => {
    const shares = mcpServerShares(
      mcpRun(1_000n, [
        { name: "mcp__github__create_issue", calls: 1, costMicros: null },
      ]),
    );
    expect(shares.map((s) => [s.key, s.micros, s.basis])).toEqual([
      ["github", null, null],
      ["~other", 1_000n, "client_attested"],
    ]);
  });

  it("splits the run's cost among the servers when their estimates come to more", () => {
    const shares = mcpServerShares(
      mcpRun(100n, [
        { name: "mcp__github__get_file", calls: 1, costMicros: 150n },
      ]),
    );
    expect(shares.map((s) => [s.key, s.micros])).toEqual([
      ["github", 100n],
      ["~other", 0n],
    ]);
  });

  it("keeps the split summing to the run when the proportions round down", () => {
    const shares = mcpServerShares(
      mcpRun(100n, [
        { name: "mcp__github__get_file", calls: 1, costMicros: 100n },
        { name: "mcp__linear__list_issues", calls: 1, costMicros: 100n },
        { name: "mcp__slack__post", calls: 1, costMicros: 100n },
      ]),
    );
    expect(shares.map((s) => [s.key, s.micros])).toEqual([
      ["github", 33n],
      ["linear", 33n],
      ["slack", 33n],
      ["~other", 1n],
    ]);
    const sum = shares.reduce((acc, s) => acc + (s.micros ?? 0n), 0n);
    expect(sum).toBe(100n);
  });

  it("answers server rows costliest first, then Everything else, summing to the total, with no daily read", async () => {
    const h = harness({
      runs: [
        mcpRun(1_000n, [
          { name: "mcp__github__create_issue", calls: 2, costMicros: 200n },
        ]),
        mcpRun(500n, [
          { name: "mcp__linear__list_issues", calls: 1, costMicros: 300n },
          { name: "mcp__github__get_file", calls: 1, costMicros: 50n },
        ]),
        pricedRun(250n),
      ],
    });
    const out = await h.handler(
      { period: PERIOD, groupBy: "mcp_server" },
      ctx(),
    );
    expect(h.readDailyTotals).not.toHaveBeenCalled();
    expect(out.rows.map((r) => [r.key, r.cost?.micros, r.runs])).toEqual([
      ["linear", "300", 1],
      ["github", "250", 2],
      ["~other", "1200", 3],
    ]);
    const sum = out.rows.reduce(
      (t, r) => t + BigInt(r.cost?.micros ?? "0"),
      0n,
    );
    expect(sum.toString()).toBe(out.total.cost?.micros);
    expect(out.rows.at(-1)?.topRuns).toEqual([]);
    expect(() => spendGet.output.parse(out)).not.toThrow();
  });
});

describe("get_spend day series and top runs", () => {
  it("answers every day of the period, oldest first, with no run a null cost", async () => {
    const h = harness({
      runs: [
        pricedRun(400n, { startedAt: new Date("2026-09-02T09:00:00Z") }),
        pricedRun(100n, { startedAt: new Date("2026-09-02T18:00:00Z") }),
      ],
    });
    const out = await h.handler(
      { period: { from: "2026-09-01", to: "2026-09-03" }, groupBy: "agent" },
      ctx(),
    );
    expect(out.days).toEqual([
      { day: "2026-09-01", cost: null, calls: 0, runs: 0 },
      {
        day: "2026-09-02",
        cost: { micros: "500", currency: "USD", basis: "client_attested" },
        calls: 8,
        runs: 2,
      },
      { day: "2026-09-03", cost: null, calls: 0, runs: 0 },
    ]);
  });

  it("lists a row's costliest runs, at most eight, each with its name", async () => {
    const runs = Array.from({ length: 10 }, (_, i) =>
      pricedRun(BigInt((i + 1) * 100)),
    );
    const costliest = runs[9];
    if (costliest === undefined) throw new Error("no run");
    const h = harness({
      daily: [daily({ groupKind: "agent", groupKey: "acme.core.cc" })],
      runs,
      names: { [costliest.runId]: "Fix the billing test" },
      harnesses: { [costliest.runId]: "codex" },
    });
    const out = await h.handler({ period: PERIOD, groupBy: "agent" }, ctx());
    const top = out.rows[0]?.topRuns ?? [];
    expect(top).toHaveLength(8);
    expect(top.map((r) => r.cost?.micros)).toEqual([
      "1000",
      "900",
      "800",
      "700",
      "600",
      "500",
      "400",
      "300",
    ]);
    expect(top[0]).toMatchObject({
      runId: costliest.runId,
      name: "Fix the billing test",
      harness: "codex",
      agentKey: "acme.core.cc",
      operatorKey: OPERATOR,
      startedAt: "2026-09-10T12:00:00.000Z",
    });
    expect(top[1]?.harness).toBeNull();
    expect(h.readRunNames).toHaveBeenCalledTimes(1);
    expect(h.readRunHarnesses).toHaveBeenCalledWith(
      SCOPE,
      top.map((entry) => entry.runId),
    );
    expect(() => spendGet.output.parse(out)).not.toThrow();
  });

  // ADR-235, 2026-10-02 amendment. The organization paid for the in-app
  // assistant's runs, so every figure counts them and agrees with the daily
  // rows. The assistant's spend is one row of its own, and no row lists one of
  // its runs.
  it("puts an in-app run's spend in the assistant row and names none of its runs", async () => {
    const assistant: SpendRunRecord = { ...pricedRun(900n), inApp: true };
    const external = pricedRun(400n);
    const h = harness({
      daily: [
        daily({
          groupKind: "operator",
          groupKey: OPERATOR,
          runs: 2,
          costMicros: 1300n,
          costBasis: "client_attested",
        }),
      ],
      runs: [assistant, external],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "operator" }, ctx());
    expect(out.total.runs).toBe(2);
    expect(out.total.cost?.micros).toBe("1300");
    expect(out.reported?.micros).toBe("1300");
    expect(out.days.find((d) => d.day === "2026-09-10")).toMatchObject({
      cost: { micros: "1300" },
      runs: 2,
    });
    // The operator's row loses the assistant's share and lists only its own run.
    expect(out.rows.map((r) => r.key)).toEqual([OPERATOR, ASSISTANT_SPEND_KEY]);
    expect(out.rows[0]).toMatchObject({ runs: 1, cost: { micros: "400" } });
    expect(out.rows[0]?.topRuns.map((r) => r.runId)).toEqual([
      external.runId,
    ]);
    // The assistant row carries the rest, names no run, operator or provider.
    expect(out.rows[1]).toMatchObject({
      key: ASSISTANT_SPEND_KEY,
      runs: 1,
      cost: { micros: "900" },
      operator: null,
      provider: null,
      topRuns: [],
      proven: null,
      accepted: null,
    });
    // The rows sum to the total.
    const sum = out.rows.reduce(
      (acc, r) => acc + BigInt(r.cost?.micros ?? "0"),
      0n,
    );
    expect(sum).toBe(1300n);
    // Nothing is read about the assistant's run, its name included.
    expect(h.readRunNames).toHaveBeenCalledWith(SCOPE, [external.runId]);
    expect(h.readRunHarnesses).toHaveBeenCalledWith(SCOPE, [external.runId]);
    expect(() => spendGet.output.parse(out)).not.toThrow();
  });

  it("returns no assistant row for a period with no in-app run", async () => {
    const h = harness({
      daily: [
        daily({
          groupKind: "operator",
          groupKey: OPERATOR,
          costMicros: 400n,
          costBasis: "client_attested",
        }),
      ],
      runs: [pricedRun(400n)],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "operator" }, ctx());
    expect(out.rows.map((r) => r.key)).toEqual([OPERATOR]);
  });

  it("names the agent's registered harness on a top run that recorded none, and keeps a recorded one", async () => {
    const ledger = pricedRun(900n);
    const wrapped = pricedRun(800n);
    const h = harness({
      daily: [daily({ groupKind: "agent", groupKey: "acme.core.cc" })],
      runs: [ledger, wrapped],
      harnesses: { [wrapped.runId]: "codex" },
      agentHarnesses: { "acme.core.cc": "claude-code" },
    });
    const out = await h.handler({ period: PERIOD, groupBy: "agent" }, ctx());
    const top = out.rows[0]?.topRuns ?? [];
    expect(top.find((r) => r.runId === ledger.runId)?.harness).toBe(
      "claude-code",
    );
    expect(top.find((r) => r.runId === wrapped.runId)?.harness).toBe("codex");
    expect(h.readAgentHarnesses).toHaveBeenCalledWith(SCOPE, [
      "acme.core.cc",
      "acme.core.cc",
    ]);
  });

  it("gives a model row's runs that model's part of each run", async () => {
    const h = harness({
      daily: [
        daily({
          groupKind: "model",
          groupKey: "claude-sonnet-5",
          costMicros: 700n,
          costBasis: "client_attested",
        }),
      ],
      runs: [pricedRun(700n)],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "model" }, ctx());
    expect(out.rows[0]?.topRuns[0]).toMatchObject({
      cost: { micros: "700", basis: "client_attested" },
      calls: 2,
    });
  });

  it("lists a tool row's runs by calls, with no money", async () => {
    const h = harness({
      daily: [daily({ groupKind: "tool", groupKey: "Read" })],
      runs: [pricedRun(700n)],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "tool" }, ctx());
    expect(out.rows[0]?.topRuns[0]).toMatchObject({ cost: null, calls: 2 });
  });
});

describe("get_spend prompt sources (#5295)", () => {
  /** A priced run with the token sources the rollup stores beside its record. */
  const measuredRun = (
    sources: {
      toolDefinitionTokens: number | null;
      contextFrameTokens: number | null;
      steeringTokens: number | null;
    },
    resultTokens: (number | null)[] = [],
    over: Parameters<typeof pricedRun>[1] = {},
  ): SpendRunRecord => {
    const base = pricedRun(500n, over);
    return Object.assign(
      {
        ...base,
        breakdown: {
          ...base.breakdown,
          tools: resultTokens.map((tokens, i) => ({
            name: `Tool${String(i)}`,
            calls: 1,
            resultTokens: tokens,
            costMicros: null,
          })),
        },
      },
      sources,
    );
  };

  it("sums an agent's runs' tool definitions, context frames, steering and tool results, and keeps a source no run measured null", async () => {
    const h = harness({
      daily: [daily({ groupKind: "agent", groupKey: "acme.core.cc" })],
      runs: [
        measuredRun(
          {
            toolDefinitionTokens: 12_000,
            contextFrameTokens: null,
            steeringTokens: 400,
          },
          [800, null],
        ),
        measuredRun(
          {
            toolDefinitionTokens: 6_000,
            contextFrameTokens: null,
            steeringTokens: null,
          },
          [1_200],
        ),
      ],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "agent" }, ctx());
    expect(out.rows[0]?.tokenSources).toEqual({
      toolDefinitionTokens: 18_000,
      // No run measured context frames, so the sum is null, not zero.
      contextFrameTokens: null,
      steeringTokens: 400,
      toolResultTokens: 2_000,
    });
    expect(() => spendGet.output.parse(out)).not.toThrow();
  });

  it("answers every source null for a row whose runs measured none (negative)", async () => {
    const h = harness({
      daily: [daily({ groupKind: "agent", groupKey: "acme.core.cc" })],
      runs: [pricedRun(500n)],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "agent" }, ctx());
    expect(out.rows[0]?.tokenSources).toEqual({
      toolDefinitionTokens: null,
      contextFrameTokens: null,
      steeringTokens: null,
      toolResultTokens: null,
    });
  });

  it("carries no sources on a model row, which holds part of a run (negative)", async () => {
    const h = harness({
      daily: [
        daily({
          groupKind: "model",
          groupKey: "claude-sonnet-5",
          costMicros: 500n,
          costBasis: "client_attested",
        }),
      ],
      runs: [
        measuredRun({
          toolDefinitionTokens: 12_000,
          contextFrameTokens: null,
          steeringTokens: 400,
        }),
      ],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "model" }, ctx());
    expect(out.rows[0]).not.toHaveProperty("tokenSources");
  });

  it("gives the assistant row its own runs' sources, and leaves them out of the operator's row", async () => {
    const assistant: SpendRunRecord = {
      ...measuredRun({
        toolDefinitionTokens: 9_000,
        contextFrameTokens: null,
        steeringTokens: null,
      }),
      inApp: true,
    };
    const external = measuredRun({
      toolDefinitionTokens: 1_000,
      contextFrameTokens: null,
      steeringTokens: null,
    });
    const h = harness({
      daily: [
        daily({
          groupKind: "operator",
          groupKey: OPERATOR,
          runs: 2,
          costMicros: 1000n,
          costBasis: "client_attested",
        }),
      ],
      runs: [assistant, external],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "operator" }, ctx());
    expect(out.rows.map((r) => [r.key, r.tokenSources?.toolDefinitionTokens]))
      .toEqual([
        [OPERATOR, 1_000],
        [ASSISTANT_SPEND_KEY, 9_000],
      ]);
  });
});

describe("get_spend request windows (#5341)", () => {
  /** A priced run whose rollup stored the window composition given; undefined stores none. */
  const windowedRun = (
    windows: NonNullable<SpendRunRecord["breakdown"]["windows"]> | null | undefined,
    over: Parameters<typeof pricedRun>[1] = {},
  ): SpendRunRecord => {
    const base = pricedRun(500n, over);
    return {
      ...base,
      breakdown: {
        ...base.breakdown,
        ...(windows === undefined ? {} : { windows }),
      },
    };
  };

  const composition = (
    blocks: { system: number | null; conversation: number | null; tools?: number | null },
    requests = 1,
  ) => {
    const tools = blocks.tools ?? null;
    return {
      requests,
      requestsWithoutTokens: 0,
      promptTokens:
        (blocks.system ?? 0) + (blocks.conversation ?? 0) + (tools ?? 0),
      blocks: {
        system: blocks.system,
        steering: null,
        tools,
        context: null,
        conversation: blocks.conversation,
      },
      initialConversationTokens: null,
    };
  };

  it("sums an agent's runs' windows block by block, past a run with none and a run rolled up before them", async () => {
    const h = harness({
      daily: [daily({ groupKind: "agent", groupKey: "acme.core.cc" })],
      runs: [
        windowedRun(composition({ system: 1_000, conversation: 4_000, tools: 3_000 }, 2)),
        windowedRun(composition({ system: 500, conversation: 2_500 }, 3)),
        // A run that recorded no window, and one rolled up before #5341.
        windowedRun(null),
        windowedRun(undefined),
      ],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "agent" }, ctx());
    expect(out.rows[0]?.windows).toEqual({
      runs: 2,
      requests: 5,
      requestsWithoutTokens: 0,
      promptTokens: 11_000,
      blocks: {
        system: 1_500,
        // No run's windows carried steering or context, so both stay null.
        steering: null,
        tools: 3_000,
        context: null,
        conversation: 6_500,
      },
    });
    expect(() => spendGet.output.parse(out)).not.toThrow();
  });

  it("answers null for a row none of whose runs stored windows, never a zero (negative)", async () => {
    const h = harness({
      daily: [daily({ groupKind: "agent", groupKey: "acme.core.cc" })],
      runs: [windowedRun(null), windowedRun(undefined)],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "agent" }, ctx());
    expect(out.rows[0]?.windows).toBeNull();
    expect(() => spendGet.output.parse(out)).not.toThrow();
  });

  it("carries no windows on a model row, which holds part of a run (negative)", async () => {
    const h = harness({
      daily: [
        daily({
          groupKind: "model",
          groupKey: "claude-sonnet-5",
          costMicros: 500n,
          costBasis: "client_attested",
        }),
      ],
      runs: [windowedRun(composition({ system: 100, conversation: 900 }))],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "model" }, ctx());
    expect(out.rows[0]).not.toHaveProperty("windows");
  });

  it("gives the assistant row its own runs' windows, and leaves them out of the operator's row", async () => {
    const h = harness({
      daily: [
        daily({
          groupKind: "operator",
          groupKey: OPERATOR,
          runs: 2,
          costMicros: 1000n,
          costBasis: "client_attested",
        }),
      ],
      runs: [
        {
          ...windowedRun(composition({ system: 200, conversation: 800 })),
          inApp: true,
        },
        windowedRun(composition({ system: 50, conversation: 950 })),
      ],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "operator" }, ctx());
    expect(
      out.rows.map((r) => [r.key, r.windows?.blocks.conversation ?? null]),
    ).toEqual([
      [OPERATOR, 950],
      [ASSISTANT_SPEND_KEY, 800],
    ]);
  });
});

describe("get_spend reported spend", () => {
  it("sums the models the harness reported and leaves gateway and mixed models out", () => {
    const reported = pricedRun(300n);
    const metered = pricedRun(900n, { costBasis: "gateway_observed" });
    const mixed = pricedRun(50n, { costBasis: "mixed" });
    expect(reportedSpend([reported, metered, mixed])).toEqual({
      micros: "300",
      currency: "USD",
    });
  });

  it("answers null when no harness-reported model carries a cost", () => {
    expect(
      reportedSpend([pricedRun(10n, { costBasis: "gateway_observed" })]),
    ).toBeNull();
    expect(reportedSpend([run()])).toBeNull();
  });
});

describe("get_spend observed spend", () => {
  it("sums the models the gateway metered and leaves reported, mixed and estimated models out", () => {
    const reported = pricedRun(300n);
    const metered = pricedRun(900n, { costBasis: "gateway_observed" });
    const mixed = pricedRun(50n, { costBasis: "mixed" });
    const estimated = pricedRun(70n, { costBasis: "estimated" });
    expect(observedSpend([reported, metered, mixed, estimated])).toEqual({
      micros: "900",
      currency: "USD",
    });
  });

  it("answers null when no gateway-observed model carries a cost (negative)", () => {
    expect(observedSpend([pricedRun(10n)])).toBeNull();
    expect(observedSpend([run()])).toBeNull();
  });

  it("answers the observed part beside the reported part on the period", async () => {
    const h = harness({
      runs: [
        pricedRun(300n),
        pricedRun(900n, { costBasis: "gateway_observed" }),
      ],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "model" }, ctx());
    expect(out.reported).toEqual({ micros: "300", currency: "USD" });
    expect(out.observed).toEqual({ micros: "900", currency: "USD" });
    expect(() => spendGet.output.parse(out)).not.toThrow();
  });
});

describe("get_spend prompt composition", () => {
  it("sums each standing source and the tool results over the period's runs", async () => {
    const measured: SpendRunRecord = {
      ...pricedRun(300n),
      toolDefinitionTokens: 4_000,
      contextFrameTokens: 0,
      steeringTokens: null,
    };
    measured.breakdown = {
      ...measured.breakdown,
      tools: [
        { name: "Read", calls: 2, resultTokens: 1_200, costMicros: 12n },
        { name: "Bash", calls: 1, resultTokens: null, costMicros: null },
      ],
    };
    const other: SpendRunRecord = {
      ...pricedRun(100n),
      toolDefinitionTokens: 1_000,
    };
    const h = harness({ runs: [measured, other] });
    const out = await h.handler({ period: PERIOD, groupBy: "model" }, ctx());
    // A source measured at 0 is a reading of 0; a source no run measured is null.
    expect(out.composition).toEqual({
      toolDefinitionTokens: 5_000,
      contextFrameTokens: 0,
      steeringTokens: null,
      toolResultTokens: 1_200,
    });
    expect(() => spendGet.output.parse(out)).not.toThrow();
  });

  it("answers every part null when no run measured one (negative)", () => {
    expect(promptComposition([run(), pricedRun(10n)])).toEqual({
      toolDefinitionTokens: null,
      contextFrameTokens: null,
      steeringTokens: null,
      toolResultTokens: null,
    });
  });
});

describe("get_spend run operators (#2962)", () => {
  const PERSON: OperatorFacts = {
    id: OPERATOR,
    name: "Marcus Bell",
    email: "marcus@example.com",
    avatarUrl: null,
    role: "Member",
  };

  it("names each listed run's operator, in one read with no key twice", async () => {
    const first = pricedRun(900n);
    const second = pricedRun(800n);
    const nobody = pricedRun(700n, {
      operatorKey: null,
      operatorPrincipalId: null,
    });
    const h = harness({
      daily: [daily({ groupKind: "agent", groupKey: "acme.core.cc" })],
      runs: [first, second, nobody],
      people: [PERSON],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "agent" }, ctx());
    const top = out.rows[0]?.topRuns ?? [];
    expect(top.map((r) => r.operator ?? null)).toEqual([PERSON, PERSON, null]);
    // An agent row names no operator of its own.
    expect(out.rows[0]?.operator).toBeNull();
    expect(h.readOperatorFacts).toHaveBeenCalledTimes(1);
    expect(h.readOperatorFacts).toHaveBeenCalledWith(SCOPE, [
      OPERATOR,
    ]);
    expect(() => spendGet.output.parse(out)).not.toThrow();
  });

  it("reads the operator rows and their runs' operators together", async () => {
    const h = harness({
      daily: [
        daily({
          groupKind: "operator",
          groupKey: OPERATOR,
          costMicros: 400n,
          costBasis: "client_attested",
        }),
      ],
      runs: [pricedRun(400n)],
      people: [PERSON],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "operator" }, ctx());
    expect(out.rows[0]?.operator).toEqual(PERSON);
    expect(out.rows[0]?.topRuns[0]?.operator).toEqual(PERSON);
    expect(h.readOperatorFacts).toHaveBeenCalledTimes(1);
    expect(h.readOperatorFacts).toHaveBeenCalledWith(SCOPE, [
      OPERATOR,
    ]);
  });

  it("leaves an operator nobody can name null rather than print the key", async () => {
    const h = harness({
      daily: [daily({ groupKind: "agent", groupKey: "acme.core.cc" })],
      runs: [pricedRun(400n)],
      people: [],
    });
    const out = await h.handler({ period: PERIOD, groupBy: "agent" }, ctx());
    expect(out.rows[0]?.topRuns[0]).toMatchObject({
      operatorKey: OPERATOR,
      operator: null,
    });
  });
});

describe("get_spend by work item (#2962)", () => {
  const SEND: RunWorkOrderRef = {
    workOrderId: "0192d4a8-7c1e-7a00-8000-0000000000f1",
    workOrderKind: "send",
  };
  const ATTACHED: RunWorkOrderRef = {
    workOrderId: "0192d4a8-7c1e-7a00-8000-0000000000f2",
    workOrderKind: "direct",
  };
  /** A direct work order nobody attached to a work item. */
  const LOOSE: RunWorkOrderRef = {
    workOrderId: "0192d4a8-7c1e-7a00-8000-0000000000f3",
    workOrderKind: "direct",
  };
  const LOGIN: RunWorkItem = {
    id: "wi_0000000000000000000001",
    number: "OPS-88",
    subject: "Fix the login page",
  };
  const BILLING: RunWorkItem = {
    id: "wi_0000000000000000000002",
    number: "OPS-90",
    subject: "Retry the billing sync",
  };
  const ITEMS: [RunWorkOrderRef, RunWorkItem][] = [
    [SEND, LOGIN],
    [ATTACHED, BILLING],
  ];

  function month() {
    const sent = pricedRun(900n, { ...SEND });
    const sentAgain = pricedRun(300n, { ...SEND });
    // Priced by nothing: its row's cost is null, never 0.
    const attached = run({ ...ATTACHED });
    const loose = pricedRun(200n, { ...LOOSE });
    const terminal = pricedRun(100n);
    const assistant: SpendRunRecord = { ...pricedRun(50n), inApp: true };
    return {
      sent,
      sentAgain,
      attached,
      loose,
      terminal,
      assistant,
      runs: [sent, sentAgain, attached, loose, terminal, assistant],
    };
  }

  it("puts each run on the work item it served, the rest on No work item, and sums to the total", async () => {
    const m = month();
    const h = harness({ runs: m.runs, workItems: ITEMS });
    const out = await h.handler({ period: PERIOD, groupBy: "work_item" }, ctx());
    expect(out.groupBy).toBe("work_item");
    expect(out.rows.map((r) => r.key)).toEqual([
      LOGIN.id,
      NO_WORK_ITEM_KEY,
      BILLING.id,
      ASSISTANT_SPEND_KEY,
    ]);
    expect(out.rows[0]).toMatchObject({
      workItem: LOGIN,
      runs: 2,
      cost: { micros: "1200", basis: "client_attested" },
    });
    expect(out.rows[0]?.topRuns.map((r) => r.runId)).toEqual([
      m.sent.runId,
      m.sentAgain.runId,
    ]);
    // A direct work order nobody attached and a run with no work order serve
    // no work item.
    expect(out.rows[1]).toMatchObject({
      workItem: null,
      runs: 2,
      cost: { micros: "300" },
    });
    expect(out.rows[2]).toMatchObject({
      workItem: BILLING,
      runs: 1,
      cost: null,
    });
    // The assistant's row names no work item: Oxagen runs it (ADR-235).
    expect(out.rows[3]).toMatchObject({ topRuns: [] });
    expect(out.rows[3]).not.toHaveProperty("workItem");
    const sum = out.rows.reduce(
      (acc, r) => acc + BigInt(r.cost?.micros ?? "0"),
      0n,
    );
    expect(out.total.cost?.micros).toBe("1550");
    expect(sum).toBe(1550n);
    expect(() => spendGet.output.parse(out)).not.toThrow();
  });

  it("reads no daily rollup and no work item for an assistant run", async () => {
    const m = month();
    const h = harness({ runs: m.runs, workItems: ITEMS });
    await h.handler({ period: PERIOD, groupBy: "work_item" }, ctx());
    expect(h.readDailyTotals).not.toHaveBeenCalled();
    expect(h.readRunWorkItems).toHaveBeenCalledTimes(1);
    expect(h.readRunWorkItems).toHaveBeenCalledWith(SCOPE, [
      SEND,
      SEND,
      ATTACHED,
      LOOSE,
    ]);
  });

  it("carries the prompt sources of a row of whole runs", async () => {
    const m = month();
    const h = harness({ runs: m.runs, workItems: ITEMS });
    const out = await h.handler({ period: PERIOD, groupBy: "work_item" }, ctx());
    expect(out.rows[0]?.tokenSources).toBeDefined();
  });

  it("leaves workItem off every other grouping", async () => {
    const h = harness({
      daily: [daily({ groupKind: "agent", groupKey: "acme.core.cc" })],
      runs: [pricedRun(400n, { ...SEND })],
      workItems: ITEMS,
    });
    const out = await h.handler({ period: PERIOD, groupBy: "agent" }, ctx());
    expect(out.rows[0]).not.toHaveProperty("workItem");
    expect(h.readRunWorkItems).not.toHaveBeenCalled();
  });
});
