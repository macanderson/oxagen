import { describe, expect, it } from "vitest";
import {
  assemblyOf,
  createWindowComposition,
  ledgerContextWindows,
  type RecordedWindow,
  tachoContextWindow,
  type TachoModelCallRow,
  walkLedgerContextWindows,
  windowComposition,
  wrappedContextWindows,
} from "./context-windows";
import { NO_BODY } from "./frame-body";
import type { AttemptEventReadRecord } from "./run-store";

function event(
  runSeq: number,
  eventType: string,
  payload: Record<string, unknown>,
): AttemptEventReadRecord {
  return {
    eventId: `0192d4a8-7c1e-7a00-8000-0000000000e${runSeq}`,
    attemptId: "0192d4a8-7c1e-7a00-8000-0000000000b1",
    attemptPublicId: "aatt_0123456789abcdefghjkmn",
    runSeq: String(runSeq),
    attemptSeq: runSeq,
    eventSchemaVersion: "agent-run-event/v2",
    eventType,
    stage: "model",
    payloadDigest: `sha256:${"a".repeat(64)}`,
    eventDigest: `sha256:${String(runSeq).padStart(64, "0")}`,
    payload,
    encryptedPayloadRef: null,
    observedAt: new Date("2026-09-26T10:00:00.000Z"),
    recordedAt: new Date("2026-09-26T10:00:00.500Z"),
    body: NO_BODY,
  };
}

const WINDOW = {
  blocks: [
    { kind: "system", bytes: 1000, items: 1 },
    { kind: "steering", bytes: 250, items: 1 },
    { kind: "tools", bytes: 3000, items: 12 },
    { kind: "context", bytes: 500, items: 2 },
    { kind: "conversation", bytes: 5250, items: 9 },
  ],
};

/** A call's start frame. `null` records it with no window at all. */
const started = (seq: number, id: string, window: unknown = WINDOW) =>
  event(seq, "model.engine_call_started", {
    engine_seq: seq,
    model_call_id: id,
    role: "worker",
    provider: "oxagen",
    model: "anthropic/claude-sonnet-4",
    ...(window === null ? {} : { window }),
  });

const completed = (seq: number, id: string, input?: number) =>
  event(seq, "model.engine_call_completed", {
    engine_seq: seq,
    model_call_id: id,
    role: "worker",
    provider: "oxagen",
    model: "anthropic/claude-sonnet-4.6",
    outcome: "completed",
    ...(input === undefined ? {} : { input_tokens: input }),
  });

describe("ledgerContextWindows", () => {
  it("splits the completion's reported input across the blocks, summing to it", () => {
    const { windows, unmeasured } = ledgerContextWindows([
      started(2, "prov-1-0"),
      completed(3, "prov-1-0", 12_345),
    ]);
    expect(unmeasured).toBe(0);
    expect(windows).toHaveLength(1);
    const [window] = windows;
    expect(window).toMatchObject({
      seq: "2",
      responseSeq: "3",
      modelCallId: "prov-1-0",
      provider: "oxagen",
      // The model that answered wins over the one the host asked for.
      model: "anthropic/claude-sonnet-4.6",
      promptTokens: 12_345,
      bytes: 10_000,
    });
    const tokens = window?.blocks.map((block) => block.tokens) ?? [];
    expect(tokens.reduce<number>((sum, t) => sum + (t ?? 0), 0)).toBe(12_345);
    // 10%, 2.5%, 30%, 5% and 52.5% of 12,345.
    expect(tokens).toEqual([1235, 309, 3703, 617, 6481]);
  });

  it("keeps the bytes of a call that never answered, with no tokens", () => {
    const { windows } = ledgerContextWindows([started(2, "prov-1-0")]);
    expect(windows[0]).toMatchObject({ responseSeq: null, promptTokens: null });
    expect(windows[0]?.blocks.every((block) => block.tokens === null)).toBe(
      true,
    );
  });

  it("counts a completed call with no window as unmeasured, never filling one in", () => {
    const { windows, unmeasured } = ledgerContextWindows([
      started(2, "prov-1-0", null),
      completed(3, "prov-1-0", 900),
      started(4, "prov-1-1"),
      completed(5, "prov-1-1", 1000),
    ]);
    expect(windows.map((w) => w.seq)).toEqual(["4"]);
    expect(unmeasured).toBe(1);
  });

  it("reads the manifest summary the assembler recorded", () => {
    const { assemblies } = ledgerContextWindows([
      event(1, "steering.manifest", {
        schema: "oxagen.steering.manifest/1",
        delivers: ["must", "should"],
        budget_tokens: 2000,
        spent_tokens: 415,
        included: 8,
        cut: 3,
        text_digest: `sha256:${"b".repeat(64)}`,
        manifest_digest: `sha256:${"c".repeat(64)}`,
      }),
    ]);
    expect(assemblies).toEqual([
      {
        seq: "1",
        budgetTokens: 2000,
        spentTokens: 415,
        included: 8,
        cut: 3,
        textDigest: `sha256:${"b".repeat(64)}`,
      },
    ]);
  });

  it("drops a window that does not read as one", () => {
    const { windows } = ledgerContextWindows([
      started(2, "prov-1-0", { blocks: [{ kind: "memory", bytes: 1, items: 1 }] }),
    ]);
    expect(windows).toEqual([]);
  });
});

function llmCall(over: Partial<TachoModelCallRow> = {}): TachoModelCallRow {
  return {
    seq: 14,
    kind: "llm_call",
    attrs: { "oxagen.window": "system=100:1;tools=300:4;conversation=600:7" },
    model: "claude-opus-5",
    provider: "anthropic",
    requestId: "req_01",
    inputTokens: 40,
    cacheReadTokens: 900,
    cacheCreationTokens: 60,
    body: "{}",
    ...over,
  };
}

describe("tachoContextWindow", () => {
  it("reconciles a gateway call's window to its uncached, cache-read and cache-write input", () => {
    const window = tachoContextWindow(llmCall());
    expect(window).toMatchObject({
      seq: "14",
      responseSeq: "14",
      modelCallId: "req_01",
      promptTokens: 1000,
      bytes: 1000,
    });
    expect(window?.blocks).toEqual([
      { kind: "system", bytes: 100, items: 1, tokens: 100 },
      { kind: "tools", bytes: 300, items: 4, tokens: 300 },
      { kind: "conversation", bytes: 600, items: 7, tokens: 600 },
    ]);
  });

  it("answers no window for a call the proxy did not measure", () => {
    expect(tachoContextWindow(llmCall({ attrs: {} }))).toBeNull();
    expect(tachoContextWindow(llmCall({ attrs: undefined }))).toBeNull();
    expect(
      tachoContextWindow(llmCall({ attrs: { "oxagen.window": "bad" } })),
    ).toBeNull();
    expect(tachoContextWindow(llmCall({ kind: "tool_call" }))).toBeNull();
  });

  it("has no tokens when the vendor reported no input count", () => {
    const window = tachoContextWindow(llmCall({ inputTokens: null }));
    expect(window?.promptTokens).toBeNull();
    expect(window?.blocks.every((block) => block.tokens === null)).toBe(true);
  });
});

describe("assemblyOf", () => {
  it("reads nothing from a manifest that leaves a member out", () => {
    expect(assemblyOf("3", { budget_tokens: 2000, spent_tokens: 10 })).toBeNull();
    expect(assemblyOf("3", null)).toBeNull();
  });
});

/** A measured window whose blocks carry the tokens given, in block order. */
function measured(
  seq: number,
  blocks: readonly [RecordedWindow["blocks"][number]["kind"], number, number][],
  promptTokens: number | null = blocks.reduce((sum, [, , t]) => sum + t, 0),
): RecordedWindow {
  return {
    seq: String(seq),
    responseSeq: String(seq),
    modelCallId: `req_${String(seq)}`,
    provider: "anthropic",
    model: "claude-opus-5",
    promptTokens,
    bytes: blocks.reduce((sum, [, , t]) => sum + t, 0),
    blocks: blocks.map(([kind, items, tokens]) => ({
      kind,
      bytes: tokens,
      items,
      tokens: promptTokens === null ? null : tokens,
    })),
  };
}

describe("windowComposition", () => {
  it("sums each block over every window, and the blocks sum to the prompt total", () => {
    const composition = windowComposition([
      measured(1, [
        ["system", 1, 100],
        ["tools", 4, 300],
        ["conversation", 2, 50],
      ]),
      measured(2, [
        ["system", 1, 100],
        ["tools", 4, 300],
        ["conversation", 5, 400],
      ]),
    ]);
    expect(composition).toEqual({
      requests: 2,
      requestsWithoutTokens: 0,
      promptTokens: 1250,
      blocks: {
        system: 200,
        steering: null,
        tools: 600,
        context: null,
        conversation: 450,
      },
      initialConversationTokens: 50,
    });
  });

  it("leaves a block no window carried null, never zero (negative)", () => {
    // A wrapped window has no context block (ADR-200 section 2).
    const composition = windowComposition([
      measured(1, [
        ["system", 1, 10],
        ["conversation", 1, 90],
      ]),
    ]);
    expect(composition?.blocks.context).toBeNull();
    expect(composition?.blocks.steering).toBeNull();
    expect(composition?.blocks.tools).toBeNull();
  });

  it("takes the first window that declared tools as the first request, past a side call", () => {
    const composition = windowComposition([
      // A title call: a short prompt and no tools.
      measured(1, [
        ["system", 1, 20],
        ["conversation", 1, 30],
      ]),
      measured(2, [
        ["system", 1, 100],
        ["tools", 4, 300],
        ["conversation", 1, 70],
      ]),
      measured(3, [
        ["system", 1, 100],
        ["tools", 4, 300],
        ["conversation", 3, 500],
      ]),
    ]);
    expect(composition?.initialConversationTokens).toBe(70);
    expect(composition?.blocks.conversation).toBe(600);
  });

  it("takes the first window when none declared tools", () => {
    const composition = windowComposition([
      measured(1, [["conversation", 1, 30]]),
      measured(2, [
        ["tools", 0, 0],
        ["conversation", 2, 80],
      ]),
    ]);
    expect(composition?.initialConversationTokens).toBe(30);
  });

  it("counts a window with no prompt total apart, and sums none of its blocks", () => {
    const composition = windowComposition([
      measured(
        1,
        [
          ["tools", 4, 300],
          ["conversation", 1, 70],
        ],
        null,
      ),
      measured(2, [
        ["tools", 4, 300],
        ["conversation", 3, 500],
      ]),
    ]);
    expect(composition).toMatchObject({
      requests: 1,
      requestsWithoutTokens: 1,
      promptTokens: 800,
      // The first request reported no total, so its prompt is not known.
      initialConversationTokens: null,
    });
    expect(composition?.blocks.conversation).toBe(500);
  });

  it("answers null when no window reported a prompt total (negative)", () => {
    expect(windowComposition([])).toBeNull();
    expect(
      windowComposition([measured(1, [["conversation", 1, 30]], null)]),
    ).toBeNull();
  });
});

describe("createWindowComposition", () => {
  it("sums one window at a time to what windowComposition answers for the list", () => {
    const windows = [
      measured(1, [
        ["system", 1, 20],
        ["conversation", 1, 30],
      ]),
      measured(2, [
        ["system", 1, 100],
        ["tools", 4, 300],
        ["conversation", 1, 70],
      ]),
      measured(3, [["conversation", 2, 90]], null),
    ];
    const composition = createWindowComposition();
    for (const window of windows) composition.add(window);
    expect(composition.finish()).toEqual(windowComposition(windows));
    expect(composition.finish()).toMatchObject({
      requests: 2,
      requestsWithoutTokens: 1,
      promptTokens: 520,
      initialConversationTokens: 70,
    });
  });

  it("answers null before any window reported a prompt total (negative)", () => {
    const composition = createWindowComposition();
    expect(composition.finish()).toBeNull();
    composition.add(measured(1, [["conversation", 1, 30]], null));
    expect(composition.finish()).toBeNull();
  });
});

describe("walkLedgerContextWindows", () => {
  const EVENTS = [
    event(1, "run.admitted", {}),
    started(2, "prov-1-0"),
    completed(3, "prov-1-0", 10_000),
    event(4, "tool.engine_call_completed", {}),
    started(5, "prov-1-1"),
    completed(6, "prov-1-1", 20_000),
  ];

  /** The store's page read over EVENTS, recording each cursor it was asked for. */
  function pages() {
    const asked: string[] = [];
    const readPage = async (after: string, limit: number) => {
      asked.push(after);
      return EVENTS.filter((e) => Number(e.runSeq) > Number(after)).slice(
        0,
        limit,
      );
    };
    return { asked, readPage };
  }

  it("pages through every event and reads the windows across the pages", async () => {
    const { asked, readPage } = pages();
    const reading = await walkLedgerContextWindows(readPage, {
      cap: 100,
      page: 2,
    });
    expect(asked).toEqual(["0", "2", "4", "6"]);
    expect(reading.walked).toBe(true);
    expect(reading.windows.map((w) => w.promptTokens)).toEqual([
      10_000, 20_000,
    ]);
    expect(reading.unmeasured).toBe(0);
  });

  it("says the walk is a prefix when it stops at its cap (negative)", async () => {
    const { readPage } = pages();
    const reading = await walkLedgerContextWindows(readPage, {
      cap: 4,
      page: 2,
    });
    expect(reading.walked).toBe(false);
    // The cap admits four events, so only the first call's window was reached.
    expect(reading.windows.map((w) => w.modelCallId)).toEqual(["prov-1-0"]);
  });
});

describe("wrappedContextWindows", () => {
  it("reads windows and manifests, and counts a call with no window once", () => {
    const reading = wrappedContextWindows([
      llmCall({
        seq: 1,
        kind: "steering.manifest",
        attrs: undefined,
        body: JSON.stringify({
          budget_tokens: 2000,
          spent_tokens: 400,
          included: 3,
          cut: 1,
        }),
      }),
      // The transcript's sighting of req_01, which the proxy measured later.
      llmCall({ seq: 2, attrs: {}, requestId: "req_01" }),
      llmCall({ seq: 3 }),
      // A call nobody measured, and a later sighting of it.
      llmCall({ seq: 4, attrs: {}, requestId: "req_02" }),
      llmCall({
        seq: 5,
        attrs: { "oxagen.llm_call_duplicate_of": "transcript" },
        requestId: "req_02",
      }),
    ]);
    expect(reading.windows.map((w) => w.seq)).toEqual(["3"]);
    expect(reading.assemblies.map((a) => a.seq)).toEqual(["1"]);
    expect(reading.unmeasured).toBe(1);
  });
});
