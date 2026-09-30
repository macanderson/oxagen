/**
 * What the tool-call ledger takes on from another ledger's state: the calls
 * an older build's subagent chain remembered, which a restart moves into the
 * session family's ledger (ADR-168). And which calls it has met, which the
 * MCP gateway asks before it seals a call (ADR-189 decision 7).
 */
import { describe, expect, it } from "vitest";
import { TOOL_CALL_LEDGER_CAPACITY, ToolCallLedger } from "./tool-call-dedupe";

describe("ToolCallLedger.absorb", () => {
  it("keeps its own entry, body flag included, for a call both ledgers hold", () => {
    const root = new ToolCallLedger();
    root.judge("toolu_shared", "hook", true).commit();
    const child = new ToolCallLedger();
    child.judge("toolu_shared", "otel_log", false).commit();
    child.judge("toolu_child", "hook", true).commit();
    root.absorb(child.state());
    expect(root.state().calls).toEqual([
      ["toolu_shared", ["hook"], true],
      ["toolu_child", ["hook"], true],
    ]);
    expect(root.judge("toolu_shared", "transcript", true).verdict).toEqual({
      kind: "repeat",
    });
    expect(root.judge("toolu_child", "otel_log", false).verdict).toEqual({
      kind: "repeat",
    });
  });

  it("forgets its oldest calls when an absorb takes it past its capacity", () => {
    const root = new ToolCallLedger();
    root.judge("toolu_root", "hook", true).commit();
    const child = new ToolCallLedger();
    for (let i = 0; i < TOOL_CALL_LEDGER_CAPACITY; i += 1) {
      child.judge(`toolu_${i}`, "hook", true).commit();
    }
    root.absorb(child.state());
    expect(root.state().calls).toHaveLength(TOOL_CALL_LEDGER_CAPACITY);
    expect(root.judge("toolu_root", "hook", true).verdict).toEqual({
      kind: "first",
    });
    expect(
      root.judge(`toolu_${TOOL_CALL_LEDGER_CAPACITY - 1}`, "otel_log", false)
        .verdict,
    ).toEqual({ kind: "repeat" });
  });
});

describe("ToolCallLedger.knows", () => {
  it("knows a call from its claim or its first committed sighting on", () => {
    const ledger = new ToolCallLedger();
    expect(ledger.knows("toolu_gateway")).toBe(false);
    ledger.claim("toolu_gateway");
    expect(ledger.knows("toolu_gateway")).toBe(true);
    expect(ledger.awaits("toolu_gateway")).toBe(true);
    ledger.judge("toolu_gateway", "gateway", true).commit();
    // Met and no longer awaited: a second gateway call naming it is not the
    // one the session waits on.
    expect(ledger.knows("toolu_gateway")).toBe(true);
    expect(ledger.awaits("toolu_gateway")).toBe(false);

    ledger.judge("toolu_otel", "otel_log", false).commit();
    expect(ledger.knows("toolu_otel")).toBe(true);
    // A verdict nobody committed registers nothing.
    ledger.judge("toolu_refused", "hook", true);
    expect(ledger.knows("toolu_refused")).toBe(false);
  });
});
