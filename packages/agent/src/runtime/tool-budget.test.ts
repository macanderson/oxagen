import { describe, it, expect } from "vitest";
import type { ToolSet } from "ai";
import {
  PROVIDER_TOOL_LIMITS,
  TooManyToolsForProviderError,
  assertToolListFitsProvider,
  describeToolBudget,
  estimateToolListTokens,
} from "./tool-budget";

/** A tool of roughly controllable size, so a test can assert on relative cost. */
function tool(description: string): ToolSet[string] {
  return {
    description,
    parameters: { type: "object", properties: {} },
  } as unknown as ToolSet[string];
}

function toolsNamed(count: number, description = "does a thing"): ToolSet {
  const out: Record<string, ToolSet[string]> = {};
  for (let i = 0; i < count; i += 1) out[`tool_${i}`] = tool(description);
  return out as ToolSet;
}

describe("estimateToolListTokens", () => {
  it("counts nothing for an empty list", () => {
    expect(estimateToolListTokens({} as ToolSet)).toBe(0);
  });

  it("grows with the number of tools", () => {
    const ten = estimateToolListTokens(toolsNamed(10));
    const twenty = estimateToolListTokens(toolsNamed(20));
    expect(twenty).toBeGreaterThan(ten);
  });

  it("grows with the size of a tool's description", () => {
    const terse = estimateToolListTokens({ a: tool("x") } as ToolSet);
    const verbose = estimateToolListTokens({
      a: tool("x".repeat(4000)),
    } as ToolSet);
    expect(verbose).toBeGreaterThan(terse);
  });

  it("counts a tool whose schema cannot be serialized, rather than throwing", () => {
    // A measurement must never be the thing that fails a turn. A circular
    // schema is counted at its name alone and the turn proceeds.
    const circular: Record<string, unknown> = { description: "cycles" };
    circular.self = circular;
    const tools = { spins: circular } as unknown as ToolSet;
    expect(() => estimateToolListTokens(tools)).not.toThrow();
    expect(estimateToolListTokens(tools)).toBeGreaterThan(0);
  });
});

describe("describeToolBudget", () => {
  it("reports the count and names the largest tool", () => {
    const budget = describeToolBudget({
      small: tool("s"),
      huge: tool("h".repeat(4000)),
      medium: tool("m".repeat(100)),
    } as ToolSet);

    expect(budget.toolCount).toBe(3);
    expect(budget.largestTool?.name).toBe("huge");
    expect(budget.estimatedTokens).toBeGreaterThan(0);
  });

  it("has no largest tool when there are no tools", () => {
    const budget = describeToolBudget({} as ToolSet);
    expect(budget.toolCount).toBe(0);
    expect(budget.largestTool).toBeNull();
  });
});

describe("assertToolListFitsProvider", () => {
  it("refuses a turn the provider would refuse, before sending it", () => {
    // The case #2611 flagged as a possible outage: 271 tools against a
    // provider that caps at 128.
    expect(() =>
      assertToolListFitsProvider("openai/gpt-5", toolsNamed(271)),
    ).toThrow(TooManyToolsForProviderError);
  });

  it("says which model, which limit, how many tools, and where the limit comes from", () => {
    // The whole point of throwing rather than letting the gateway refuse: the
    // first person to see this should be able to act without instrumenting
    // anything.
    let caught: TooManyToolsForProviderError | null = null;
    try {
      assertToolListFitsProvider("openai/gpt-5", toolsNamed(271));
    } catch (err) {
      caught = err as TooManyToolsForProviderError;
    }

    expect(caught).not.toBeNull();
    expect(caught?.code).toBe("too_many_tools_for_provider");
    expect(caught?.modelId).toBe("openai/gpt-5");
    expect(caught?.toolCount).toBe(271);
    expect(caught?.maxTools).toBe(128);
    expect(caught?.message).toContain("271 tools");
    expect(caught?.message).toContain("openai/gpt-5");
    expect(caught?.message).toContain("128");
    expect(caught?.message).toContain("The request was not sent");
  });

  it("allows a list exactly at the limit", () => {
    // 128 is the cap, not the first refused value. An off-by-one here would
    // refuse turns the provider accepts.
    expect(() =>
      assertToolListFitsProvider("openai/gpt-5", toolsNamed(128)),
    ).not.toThrow();
  });

  it("allows a provider with no confirmed ceiling", () => {
    // Deliberate: refusing a turn on a limit nobody has verified would be its
    // own outage. Absence from the table means unconfirmed, not unlimited.
    expect(() =>
      assertToolListFitsProvider("anthropic/claude-fable-5-1", toolsNamed(271)),
    ).not.toThrow();
  });

  it("applies the cap to every model on a capped provider, not to named ids", () => {
    // Keyed by prefix so a new model on the same API inherits the limit —
    // the model most likely to be adopted before anyone re-reads the table.
    expect(() =>
      assertToolListFitsProvider(
        "openai/some-model-not-yet-released",
        toolsNamed(200),
      ),
    ).toThrow(TooManyToolsForProviderError);
  });

  it("returns the budget so a caller need not measure twice", () => {
    const budget = assertToolListFitsProvider("openai/gpt-5", toolsNamed(10));
    expect(budget.toolCount).toBe(10);
    expect(budget.estimatedTokens).toBeGreaterThan(0);
  });
});

describe("PROVIDER_TOOL_LIMITS", () => {
  it("gives every entry a source, so a limit is never folklore", () => {
    for (const entry of PROVIDER_TOOL_LIMITS) {
      expect(entry.source.length).toBeGreaterThan(0);
      expect(entry.maxTools).toBeGreaterThan(0);
      expect(entry.prefix.endsWith("/")).toBe(true);
    }
  });
});
