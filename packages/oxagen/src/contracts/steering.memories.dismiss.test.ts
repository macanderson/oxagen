import { describe, expect, it } from "vitest";
import {
  DISMISS_MEMORIES_MAX,
  steeringMemoriesDismiss as contract,
} from "./steering.memories.dismiss";

// dismiss_memories (memory-collection spec, Lifecycle; #4912).
describe("dismiss_memories contract", () => {
  it("dismisses unless restore is set", () => {
    expect(contract.input.parse({ memory_ids: ["mem_0a1b2c"] })).toEqual({
      memory_ids: ["mem_0a1b2c"],
      restore: false,
    });
    expect(
      contract.input.parse({ memory_ids: ["mem_0a1b2c"], restore: true }).restore,
    ).toBe(true);
  });

  it.each([
    ["no id", { memory_ids: [] }],
    ["an id that is not a memory's", { memory_ids: ["prp_0a1b2c"] }],
    [
      "more ids than one call takes",
      { memory_ids: Array.from({ length: DISMISS_MEMORIES_MAX + 1 }, (_, i) => `mem_${i}`) },
    ],
  ])("refuses %s", (_name, input) => {
    expect(contract.input.safeParse(input).success).toBe(false);
  });

  it("answers a skipped memory with its state, or null when the workspace holds none", () => {
    expect(
      contract.output.safeParse({
        changed: ["mem_0a1b2c"],
        skipped: [
          { memory_id: "mem_3d4e5f", state: "promoted" },
          { memory_id: "mem_6g7h8j", state: null },
        ],
        rejections: 1,
      }).success,
    ).toBe(true);
  });

  it("writes rejections, so the in-app agent never receives it", () => {
    expect(contract.mutates).toBe(true);
    expect(contract.sensitivity).toBe("high");
    expect(contract.surfaces).not.toContain("agent");
  });
});
