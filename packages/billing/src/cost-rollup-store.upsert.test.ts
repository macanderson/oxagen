/**
 * What `upsertRunTotals` writes on a rebuild (#3984, ADR-199). The productive
 * ratio sat in the columns a rebuild carries, which the conflict update left
 * out, so a run's first ratio stood for good however its frames changed. The
 * graded columns belong to the rollup now and are in the update.
 *
 * `writeRunTotals` is handed a fake transaction that records the insert, so
 * no module is mocked. The same write against Postgres, through
 * `upsertRunTotals`, is in cost-rollup-store.pg.test.ts.
 */
import type { Tx } from "@oxagen/database";
import { describe, expect, it } from "vitest";
import type { RunTotalsRecord } from "./cost-rollup";
import { type RunTokenSources, writeRunTotals } from "./cost-rollup-store";

type Written = {
  values: Record<string, unknown>;
  set: Record<string, unknown>;
};

/** A transaction that records the insert's values and its conflict update. */
function recordingTx(): { tx: Tx; written: Written[] } {
  const written: Written[] = [];
  const tx = {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: (config: { set: Record<string, unknown> }) => {
          written.push({ values, set: config.set });
          return Promise.resolve();
        },
      }),
    }),
  };
  return { tx: tx as unknown as Tx, written };
}

async function write(over: Partial<RunTotalsRecord> = {}): Promise<Written[]> {
  const { tx, written } = recordingTx();
  await writeRunTotals(
    tx,
    { ...record, ...over },
    new Date("2026-09-15T10:00:00.000Z"),
  );
  return written;
}

const record: RunTotalsRecord = {
  runId: "tse_upsert000000000000001",
  runSource: "tacho",
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
  operatorPrincipalId: null,
  operatorKey: null,
  agentPrincipalId: null,
  agentKey: "acme.core.bot",
  taskRef: null,
  costCenter: null,
  startedAt: new Date("2026-09-15T09:00:00.000Z"),
  sealedAt: new Date("2026-09-15T09:10:00.000Z"),
  turns: 1,
  retries: 0,
  enforcementTier: "gateway",
  replayGrade: "view",
  steps: 4,
  modelCalls: 2,
  toolCalls: 2,
  tokens: {
    input_uncached: 0,
    cache_read: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    output: 0,
    reasoning: 0,
    server_tool_request: 0,
  },
  costMicros: null,
  currency: "USD",
  costBasis: null,
  priceEntryIds: [],
  cacheHitRate: null,
  breakdown: {
    models: [],
    tools: [{ name: "Read", calls: 2, resultTokens: 900, costMicros: null }],
    steps: { failed: 1, repeated: 0, retried: 0 },
  },
  verdict: null,
  accepted: true,
  productiveRatio: 0.75,
  advancedSteps: 3,
  unproductiveSteps: 1,
};

describe("writeRunTotals", () => {
  it("rewrites the productive ratio and step counts on a rebuild of an existing row", async () => {
    const written = await write();
    expect(written).toHaveLength(1);
    const [{ set }] = written as [Written];
    // Before #3984 the update carried none of the three, so a rebuild kept
    // the ratio its first rollup wrote.
    expect(set.productiveRatio).toBe("0.75000000");
    expect(set.advancedSteps).toBe(3);
    expect(set.unproductiveSteps).toBe(1);
  });

  it("writes the graded columns on the first insert too", async () => {
    const [{ values }] = (await write()) as [Written];
    expect(values).toMatchObject({
      productiveRatio: "0.75000000",
      advancedSteps: 3,
      unproductiveSteps: 1,
      accepted: true,
    });
  });

  it("leaves a person's acceptance out of the rebuild, where another lane owns it", async () => {
    const [{ set }] = (await write()) as [Written];
    expect(Object.keys(set)).not.toContain("accepted");
  });

  it("writes a run with no graded steps as null in all three", async () => {
    const [{ set }] = (await write({
      steps: 0,
      modelCalls: 0,
      toolCalls: 0,
      breakdown: { models: [], tools: [], steps: null },
      productiveRatio: null,
      advancedSteps: null,
      unproductiveSteps: null,
    })) as [Written];
    expect(set.productiveRatio).toBeNull();
    expect(set.advancedSteps).toBeNull();
    expect(set.unproductiveSteps).toBeNull();
  });

  it("stores each tool's result cost as a decimal string and the step causes as they are", async () => {
    const [{ set }] = (await write({
      breakdown: {
        ...record.breakdown,
        tools: [
          { name: "Read", calls: 2, resultTokens: 900, costMicros: 2_700n },
        ],
      },
    })) as [Written];
    expect(set.breakdown).toEqual({
      models: [],
      tools: [
        { name: "Read", calls: 2, resultTokens: 900, costMicros: "2700" },
      ],
      steps: { failed: 1, repeated: 0, retried: 0 },
    });
  });
});

describe("writeRunTotals token sources (#4493)", () => {
  async function writeSources(sources?: RunTokenSources): Promise<Written[]> {
    const { tx, written } = recordingTx();
    await writeRunTotals(
      tx,
      record,
      new Date("2026-09-15T10:00:00.000Z"),
      sources,
    );
    return written;
  }

  it("writes the three sums on the insert and on a rebuild", async () => {
    const [{ values, set }] = (await writeSources({
      toolDefinitionTokens: 12_400,
      contextFrameTokens: null,
      steeringTokens: 0,
    })) as [Written];
    const expected = {
      toolDefinitionTokens: 12_400,
      contextFrameTokens: null,
      steeringTokens: 0,
    };
    expect(values).toMatchObject(expected);
    expect(set).toMatchObject(expected);
  });

  it("writes null, never zero, for sources the caller did not pass", async () => {
    const [{ values, set }] = (await writeSources()) as [Written];
    for (const row of [values, set]) {
      expect(row.toolDefinitionTokens).toBeNull();
      expect(row.contextFrameTokens).toBeNull();
      expect(row.steeringTokens).toBeNull();
    }
  });

  it("clamps a sum past the integer column's range", async () => {
    const [{ values }] = (await writeSources({
      toolDefinitionTokens: 3_000_000_000,
      contextFrameTokens: 2_147_483_647,
      steeringTokens: 5,
    })) as [Written];
    expect(values.toolDefinitionTokens).toBe(2_147_483_647);
    expect(values.contextFrameTokens).toBe(2_147_483_647);
    expect(values.steeringTokens).toBe(5);
  });
});
