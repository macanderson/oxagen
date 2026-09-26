/**
 * Unit tests for the get_run_context handler (ADR-193, #3894).
 *
 * The window is read from the frames that recorded the model calls: a ledger
 * run's started frames joined to their completions, and a wrapped session's
 * `llm_call` rows. The two tests the issue names are here: a gateway run's
 * window reconciles to the request's token total, and an observe-only run
 * answers no window.
 */
import type { TachoModelCallRow } from "@oxagen/run-ledger";
import { describe, expect, it } from "vitest";
import {
  createRunContextGetHandler,
  type RunContextGetDeps,
} from "./run.context.get";
import {
  ctx,
  event,
  ledgerRun,
  memoryEvents,
  memoryStores,
  OTHER_WORKSPACE,
  summary,
  tachoSession,
} from "./run.test-support";

const TACHO_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";
const SESSION_UUID = "0192d4a8-7c1e-7a00-8000-00000000c0de";
const LEDGER_ID = "arun_5f0c2e9a1b7d4c3e8f6a02";
const RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000000a1";

const WINDOW = {
  blocks: [
    { kind: "system", bytes: 1204, items: 1 },
    { kind: "steering", bytes: 310, items: 1 },
    { kind: "tools", bytes: 9120, items: 14 },
    { kind: "context", bytes: 412, items: 2 },
    { kind: "conversation", bytes: 954, items: 3 },
  ],
};

function started(runSeq: number, id: string, window: unknown = WINDOW) {
  return event(runSeq, {
    eventType: "model.engine_call_started",
    stage: "model",
    payload: {
      engine_seq: runSeq,
      model_call_id: id,
      role: "worker",
      provider: "oxagen",
      model: "anthropic/claude-sonnet-4",
      ...(window === null ? {} : { window }),
    },
  });
}

function completed(runSeq: number, id: string, input: number) {
  return event(runSeq, {
    eventType: "model.engine_call_completed",
    stage: "model",
    payload: {
      engine_seq: runSeq,
      model_call_id: id,
      role: "worker",
      provider: "oxagen",
      model: "anthropic/claude-sonnet-4.6",
      outcome: "completed",
      input_tokens: input,
      output_tokens: 80,
      cached_input_tokens: 9000,
    },
  });
}

function llmCall(
  seq: number,
  over: Partial<TachoModelCallRow> = {},
): TachoModelCallRow {
  return {
    seq,
    kind: "llm_call",
    attrs: {
      "oxagen.window": "system=2000:1;tools=6000:18;conversation=12000:40",
    },
    model: "claude-opus-5",
    provider: "anthropic",
    requestId: `req_${seq}`,
    inputTokens: 1_311,
    cacheReadTokens: 40_022,
    cacheCreationTokens: 667,
    body: "",
    ...over,
  };
}

function harness(opts: {
  events?: ReturnType<typeof event>[];
  rows?: TachoModelCallRow[];
  tier?: "observe" | "gateway";
}) {
  const stores = memoryStores(
    [ledgerRun({ publicId: LEDGER_ID, runId: RUN_UUID })],
    [
      tachoSession({
        publicId: TACHO_ID,
        session: { enforcementTier: opts.tier ?? "gateway" },
      }),
    ],
  );
  const asked: { sessionUuid: string; limit: number }[] = [];
  const deps: RunContextGetDeps = {
    queries: stores.queries,
    store: {
      getRunByPublicId: (publicId) =>
        Promise.resolve(
          publicId === LEDGER_ID
            ? summary({ publicId: LEDGER_ID, runId: RUN_UUID })
            : null,
        ),
      readAttemptEventsSince: memoryEvents(opts.events ?? []),
    },
    readRunRollups: stores.readRunRollups,
    readWitnessFor: stores.readWitnessFor,
    tachoFrames: () => Promise.resolve([]),
    modelCalls: (sessionUuid, limit) => {
      asked.push({ sessionUuid, limit });
      return Promise.resolve(
        sessionUuid === SESSION_UUID
          ? (opts.rows ?? []).slice(0, limit)
          : [],
      );
    },
  };
  return { handler: createRunContextGetHandler(deps), asked };
}

const sum = (values: readonly (number | null)[]) =>
  values.reduce<number>((total, value) => total + (value ?? 0), 0);

describe("get_run_context — a gateway run", () => {
  it("reconciles a wrapped call's window to the prompt total the vendor reported", async () => {
    const { handler, asked } = harness({ rows: [llmCall(12)] });

    const out = await handler({ runId: TACHO_ID }, ctx());

    expect(asked).toEqual([{ sessionUuid: SESSION_UUID, limit: 5_001 }]);
    expect(out).toMatchObject({
      runId: TACHO_ID,
      source: "wrapped",
      unmeasured: 0,
      complete: true,
    });
    const [window] = out.windows;
    // The request's total: uncached input, cache reads and cache writes.
    const total = 1_311 + 40_022 + 667;
    expect(window).toMatchObject({
      seq: "12",
      responseSeq: "12",
      modelCallId: "req_12",
      model: "claude-opus-5",
      promptTokens: total,
      bytes: 20_000,
    });
    expect(sum(window?.blocks.map((block) => block.tokens) ?? [])).toBe(total);
    expect(window?.blocks.map((block) => block.kind)).toEqual([
      "system",
      "tools",
      "conversation",
    ]);
  });

  it("reconciles an in-app assistant call's window to the completion's input", async () => {
    const { handler } = harness({
      events: [
        event(1, {
          eventType: "steering.manifest",
          stage: "context",
          payload: {
            schema: "oxagen.steering.manifest/1",
            delivers: ["must", "should"],
            budget_tokens: 2000,
            spent_tokens: 310,
            included: 4,
            cut: 2,
            text_digest: `sha256:${"b".repeat(64)}`,
            manifest_digest: `sha256:${"c".repeat(64)}`,
          },
        }),
        started(2, "prov-1-0"),
        completed(3, "prov-1-0", 14_203),
        event(4, { eventType: "tool.engine_call_completed" }),
      ],
    });

    const out = await handler({ runId: LEDGER_ID }, ctx());

    expect(out.source).toBe("ledger");
    expect(out.windows).toHaveLength(1);
    const [window] = out.windows;
    expect(window).toMatchObject({
      seq: "2",
      responseSeq: "3",
      modelCallId: "prov-1-0",
      model: "anthropic/claude-sonnet-4.6",
      promptTokens: 14_203,
      bytes: 12_000,
    });
    expect(sum(window?.blocks.map((block) => block.tokens) ?? [])).toBe(
      14_203,
    );
    expect(out.assemblies).toEqual([
      {
        seq: "1",
        budgetTokens: 2000,
        spentTokens: 310,
        included: 4,
        cut: 2,
        textDigest: `sha256:${"b".repeat(64)}`,
      },
    ]);
  });

  it("counts a later sighting of a measured call once", async () => {
    const { handler } = harness({
      rows: [
        // The transcript reported the call first, with no window.
        llmCall(10, { attrs: {}, requestId: "req_shared" }),
        // The proxy measured it second.
        llmCall(11, {
          requestId: "req_shared",
          attrs: {
            "oxagen.window": "system=10:1;tools=0:0;conversation=90:1",
            "oxagen.llm_call_duplicate_of": "transcript",
          },
        }),
      ],
    });

    const out = await handler({ runId: TACHO_ID }, ctx());

    expect(out.windows.map((w) => w.seq)).toEqual(["11"]);
    expect(out.unmeasured).toBe(0);
  });

  it("reads a wrapped session's manifest from its body", async () => {
    const { handler } = harness({
      rows: [
        {
          ...llmCall(0),
          kind: "steering.manifest",
          attrs: {},
          body: JSON.stringify({
            budget_tokens: 2000,
            spent_tokens: 1102,
            included: 14,
            cut: 24,
            text_digest: null,
            items: [],
          }),
        },
        { ...llmCall(1), kind: "steering.manifest", body: "not json" },
      ],
    });

    const out = await handler({ runId: TACHO_ID }, ctx());

    expect(out.assemblies).toEqual([
      {
        seq: "0",
        budgetTokens: 2000,
        spentTokens: 1102,
        included: 14,
        cut: 24,
        textDigest: null,
      },
    ]);
    expect(out.windows).toEqual([]);
  });
});

describe("get_run_context — an observe-only run", () => {
  it("answers no window, and counts the calls it recorded without one", async () => {
    const { handler } = harness({
      tier: "observe",
      rows: [
        llmCall(3, { attrs: {} }),
        llmCall(9, { attrs: { "oxagen.window": "" } }),
        // A later sighting is the same call, counted once.
        llmCall(10, {
          attrs: { "oxagen.llm_call_duplicate_of": "transcript" },
        }),
      ],
    });

    const out = await handler({ runId: TACHO_ID }, ctx());

    expect(out.windows).toEqual([]);
    expect(out.unmeasured).toBe(2);
    expect(out.complete).toBe(true);
  });

  it("answers no window for a ledger run recorded before windows existed", async () => {
    const { handler } = harness({
      events: [started(2, "prov-1-0", null), completed(3, "prov-1-0", 500)],
    });

    const out = await handler({ runId: LEDGER_ID }, ctx());

    expect(out.windows).toEqual([]);
    expect(out.unmeasured).toBe(1);
  });
});

describe("get_run_context — bounds and scope", () => {
  it("says the lists are a prefix when the rows pass the read's cap", async () => {
    const rows = Array.from({ length: 5_001 }, (_, i) =>
      llmCall(i, { attrs: {} }),
    );
    const { handler } = harness({ rows });

    const out = await handler({ runId: TACHO_ID }, ctx());

    expect(out.complete).toBe(false);
    expect(out.unmeasured).toBe(5_000);
  });

  it("keeps at most the contract's windows and says so", async () => {
    const rows = Array.from({ length: 501 }, (_, i) => llmCall(i));
    const { handler } = harness({ rows });

    const out = await handler({ runId: TACHO_ID }, ctx());

    expect(out.windows).toHaveLength(500);
    expect(out.complete).toBe(false);
  });

  it("does not find a run in another workspace", async () => {
    const { handler } = harness({ rows: [llmCall(1)] });

    await expect(
      handler({ runId: TACHO_ID }, ctx(OTHER_WORKSPACE)),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
