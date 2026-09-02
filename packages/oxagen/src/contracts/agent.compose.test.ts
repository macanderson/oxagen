import { describe, expect, it } from "vitest";
import { agentCompose } from "./agent.compose";

describe("agent.compose contract", () => {
  it("registers on the api, mcp, and agent surfaces", () => {
    expect(agentCompose.name).toBe("run_capability_chain");
    expect(agentCompose.surfaces).toEqual(["api", "mcp", "agent"]);
  });

  it("applies input defaults (maxSteps=6, autoExecute=true)", () => {
    const parsed = agentCompose.input.parse({
      goal: "Research USS Nautilus and add nodes",
    });
    expect(parsed.maxSteps).toBe(6);
    expect(parsed.autoExecute).toBe(true);
  });

  it("rejects an empty goal and an out-of-range maxSteps", () => {
    expect(agentCompose.input.safeParse({ goal: "" }).success).toBe(false);
    expect(
      agentCompose.input.safeParse({ goal: "x", maxSteps: 99 }).success,
    ).toBe(false);
  });

  it("accepts a full execution result in the output schema", () => {
    const out = agentCompose.output.parse({
      goal: "g",
      plan: [
        {
          id: "step1",
          capability: "search_web",
          rationale: "find sources",
          inputJson: '{"query":"USS Nautilus"}',
          dependsOn: [],
        },
      ],
      steps: [
        {
          id: "step1",
          capability: "search_web",
          rationale: "find sources",
          status: "success",
          input: { query: "USS Nautilus" },
          output: { results: [] },
          durationMs: 120,
        },
      ],
      summary: "Searched and found sources.",
      executed: true,
    });
    expect(out.steps[0]?.status).toBe("success");
    expect(out.executed).toBe(true);
  });

  it("declares a render directive routing to the chain card", () => {
    expect(agentCompose.render?.componentId).toBe("capability-chain-card");
  });
});
