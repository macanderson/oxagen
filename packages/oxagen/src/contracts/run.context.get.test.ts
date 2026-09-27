import { describe, expect, it } from "vitest";
import { RUN_CONTEXT_WINDOW_MAX, runContextGet } from "./run.context.get";

const window = (over: Record<string, unknown> = {}) => ({
  seq: "2",
  responseSeq: "3",
  modelCallId: "prov-1-0",
  provider: "oxagen",
  model: "anthropic/claude-sonnet-4.6",
  promptTokens: 1000,
  bytes: 1000,
  blocks: [
    { kind: "system", bytes: 100, items: 1, tokens: 100 },
    { kind: "tools", bytes: 300, items: 4, tokens: 300 },
    { kind: "conversation", bytes: 600, items: 7, tokens: 600 },
  ],
  ...over,
});

const answer = (over: Record<string, unknown> = {}) => ({
  runId: "arun_abc123",
  source: "ledger",
  windows: [window()],
  unmeasured: 0,
  assemblies: [
    {
      seq: "1",
      budgetTokens: 2000,
      spentTokens: 415,
      included: 8,
      cut: 3,
      textDigest: `sha256:${"b".repeat(64)}`,
    },
  ],
  complete: true,
  ...over,
});

describe("get_run_context contract", () => {
  it("is a console read keyed on a run public id, on the api, mcp and cli surfaces", () => {
    expect(runContextGet.name).toBe("get_run_context");
    expect(runContextGet.noBillingGate).toBe(true);
    expect(runContextGet.mutates).toBe(false);
    expect(runContextGet.surfaces).toEqual(["api", "mcp", "cli"]);
    expect(runContextGet.layers).toContain("app");
    expect(runContextGet.input.safeParse({ runId: "run_1" }).success).toBe(
      false,
    );
    expect(runContextGet.input.safeParse({ runId: "tse_abc123" }).success).toBe(
      true,
    );
    expect(
      runContextGet.input.safeParse({ runId: "tse_abc123", seq: "4" }).success,
    ).toBe(false);
  });

  it("answers each window with its blocks and their token shares", () => {
    const out = runContextGet.output.parse(answer());
    expect(out.windows[0]).toEqual(window());
  });

  it("carries a call that reported no input with null tokens", () => {
    const out = runContextGet.output.parse(
      answer({
        windows: [
          window({
            responseSeq: null,
            promptTokens: null,
            blocks: [{ kind: "system", bytes: 10, items: 1, tokens: null }],
          }),
        ],
      }),
    );
    expect(out.windows[0]?.promptTokens).toBeNull();
  });

  it("refuses a block outside the five, an empty window and an unknown key", () => {
    for (const bad of [
      window({ blocks: [{ kind: "memory", bytes: 1, items: 1, tokens: 1 }] }),
      window({ blocks: [] }),
      window({ score: 0.5 }),
    ])
      expect(
        runContextGet.output.safeParse(answer({ windows: [bad] })).success,
      ).toBe(false);
  });

  it("caps the windows one answer carries", () => {
    const many = Array.from({ length: RUN_CONTEXT_WINDOW_MAX + 1 }, () =>
      window(),
    );
    expect(
      runContextGet.output.safeParse(answer({ windows: many })).success,
    ).toBe(false);
  });
});
