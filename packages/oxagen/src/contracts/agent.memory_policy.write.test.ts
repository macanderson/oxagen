import { describe, expect, it } from "vitest";
import { agentMemoryPolicyWrite } from "./agent.memory_policy.write";

describe("agent.memory.policy.write contract", () => {
  it("registers on api+mcp+agent surfaces, workspace Owner only", () => {
    expect(agentMemoryPolicyWrite.name).toBe("update_memory_policy");
    expect(agentMemoryPolicyWrite.surfaces).toContain("api");
    expect(agentMemoryPolicyWrite.surfaces).toContain("mcp");
    expect(agentMemoryPolicyWrite.defaultRoles.workspace.Owner).toBe("allow");
    expect(agentMemoryPolicyWrite.sensitivity).toBe("medium");
  });

  it("accepts a partial policy update (all fields optional)", () => {
    expect(agentMemoryPolicyWrite.input.parse({})).toEqual({});
    expect(
      agentMemoryPolicyWrite.input.parse({ recallThreshold: 0.5 })
        .recallThreshold,
    ).toBe(0.5);
  });

  it("rejects out-of-range or non-positive values", () => {
    expect(() =>
      agentMemoryPolicyWrite.input.parse({ recallThreshold: 2 }),
    ).toThrow();
    expect(() =>
      agentMemoryPolicyWrite.input.parse({ halfLifeLowDays: 0 }),
    ).toThrow();
  });

  it("returns the full policy shape with defaults", () => {
    const parsed = agentMemoryPolicyWrite.output.parse({});
    expect(parsed.halfLifeLowDays).toBe(30);
    expect(parsed.halfLifeHighDays).toBe(90);
  });
});
