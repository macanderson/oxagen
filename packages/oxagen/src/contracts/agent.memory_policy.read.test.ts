import { describe, expect, it } from "vitest";
import { agentMemoryPolicyRead } from "./agent.memory_policy.read";

describe("agent.memory.policy.read contract", () => {
  it("registers on api+mcp+agent surfaces, workspace-readable", () => {
    expect(agentMemoryPolicyRead.name).toBe("get_memory_policy");
    expect(agentMemoryPolicyRead.surfaces).toContain("api");
    expect(agentMemoryPolicyRead.surfaces).toContain("mcp");
    expect(agentMemoryPolicyRead.surfaces).toContain("agent");
    expect(agentMemoryPolicyRead.scoped).toBe(true);
    expect(agentMemoryPolicyRead.defaultRoles.workspace.Member).toBe("allow");
  });

  it("accepts an empty input object", () => {
    expect(agentMemoryPolicyRead.input.parse({})).toEqual({});
  });

  it("applies policy output defaults (30/90 day half-lives, 0.1 recall threshold)", () => {
    const parsed = agentMemoryPolicyRead.output.parse({});
    expect(parsed.halfLifeLowDays).toBe(30);
    expect(parsed.halfLifeHighDays).toBe(90);
    expect(parsed.recallThreshold).toBe(0.1);
  });

  it("rejects a recallThreshold above 1", () => {
    expect(() =>
      agentMemoryPolicyRead.output.parse({ recallThreshold: 1.5 }),
    ).toThrow();
  });
});
