import { describe, expect, it } from "vitest";
import { runCostGet } from "./run.cost";
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
  it("is a console read keyed on a run public id, on the api, mcp, agent and cli surfaces", () => {
    expect(runContextGet.name).toBe("get_run_context");
    expect(runContextGet.noBillingGate).toBe(true);
    expect(runContextGet.mutates).toBe(false);
    expect(runContextGet.surfaces).toEqual(["api", "mcp", "agent", "cli"]);
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

  it("lets every org role that reads a run's cost read its context, Billing included (#5340)", () => {
    // The Cost tab reads both, so a role allowed one and refused the other
    // meets a refusal inside a tab it can open.
    expect(runContextGet.defaultRoles?.org?.Billing).toBe("allow");
    expect(runContextGet.defaultRoles?.org).toEqual(
      runCostGet.defaultRoles?.org,
    );
    expect(runContextGet.defaultRoles?.workspace).toEqual(
      runCostGet.defaultRoles?.workspace,
    );
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

  it("carries the run's composition, reads an answer from before as null, and refuses a block outside the five (#5295)", () => {
    const composition = {
      requests: 12,
      requestsWithoutTokens: 1,
      promptTokens: 120_000,
      blocks: {
        system: 12_000,
        steering: null,
        tools: 36_000,
        context: null,
        conversation: 72_000,
      },
      initialConversationTokens: 900,
      basis: "apportioned",
    };
    expect(
      runContextGet.output.parse(answer({ composition })).composition,
    ).toEqual(composition);
    expect(runContextGet.output.parse(answer()).composition).toBeNull();
    expect(
      runContextGet.output.parse(answer({ composition: null })).composition,
    ).toBeNull();
    for (const bad of [
      { ...composition, blocks: { ...composition.blocks, memory: 10 } },
      { ...composition, blocks: { ...composition.blocks, system: -1 } },
      { ...composition, basis: "measured" },
      { ...composition, requests: undefined },
    ])
      expect(
        runContextGet.output.safeParse(answer({ composition: bad })).success,
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
