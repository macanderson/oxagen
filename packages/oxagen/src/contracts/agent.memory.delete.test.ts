import { describe, expect, it } from "vitest";
import { agentMemoryDelete } from "./agent.memory.delete";
import { getCapability } from "../registry";

describe("agent.memory.delete capability", () => {
  it("parses a valid input with a non-empty memoryId", () => {
    const parsed = agentMemoryDelete.input.parse({ memoryId: "mem_abc" });
    expect(parsed.memoryId).toBe("mem_abc");
  });

  it("rejects an empty memoryId", () => {
    expect(() => agentMemoryDelete.input.parse({ memoryId: "" })).toThrow();
  });

  it("rejects a missing memoryId", () => {
    expect(() => agentMemoryDelete.input.parse({})).toThrow();
  });

  it("output parses { deleted: true, memoryId }", () => {
    const parsed = agentMemoryDelete.output.parse({
      deleted: true,
      memoryId: "mem_abc",
    });
    expect(parsed.deleted).toBe(true);
    expect(parsed.memoryId).toBe("mem_abc");
  });

  it("output parses { deleted: false, memoryId } when none matched", () => {
    const parsed = agentMemoryDelete.output.parse({
      deleted: false,
      memoryId: "mem_abc",
    });
    expect(parsed.deleted).toBe(false);
    expect(parsed.memoryId).toBe("mem_abc");
  });

  it("is registered under name 'delete_memory'", () => {
    expect(getCapability("delete_memory")).toBe(agentMemoryDelete);
  });

  it("is scoped", () => {
    expect(agentMemoryDelete.scoped).toBe(true);
  });

  it("surfaces include api, mcp, and agent", () => {
    expect(agentMemoryDelete.surfaces).toContain("api");
    expect(agentMemoryDelete.surfaces).toContain("mcp");
    expect(agentMemoryDelete.surfaces).toContain("agent");
  });

  it("agent.requiresApproval is true (destructive operation)", () => {
    expect(agentMemoryDelete.agent?.requiresApproval).toBe(true);
  });

  it("agent riskLevel is medium", () => {
    expect(agentMemoryDelete.agent?.riskLevel).toBe("medium");
  });
});
