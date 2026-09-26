import { describe, expect, it } from "vitest";
import {
  assemblyOf,
  ledgerContextWindows,
  tachoContextWindow,
  type TachoModelCallRow,
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

const started = (seq: number, id: string, window: unknown = WINDOW) =>
  event(seq, "model.engine_call_started", {
    engine_seq: seq,
    model_call_id: id,
    role: "worker",
    provider: "oxagen",
    model: "anthropic/claude-sonnet-4",
    ...(window === undefined ? {} : { window }),
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
      started(2, "prov-1-0", undefined),
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
