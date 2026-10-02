import { describe, expect, it } from "vitest";
import { steeringMemoriesGet as contract } from "./steering.memories.get";

// get_workspace_memory (memory-collection spec, Memories tab; #4912).
describe("get_workspace_memory contract", () => {
  it("takes a memory's public id", () => {
    expect(contract.input.parse({ memory_id: "mem_0a1b2c" })).toEqual({
      memory_id: "mem_0a1b2c",
    });
  });

  it.each([
    ["a uuid", { memory_id: "0192d4a8-7c1e-7a00-8000-00000000ac3e" }],
    ["another table's id", { memory_id: "mpr_0a1b2c" }],
    ["no id", {}],
  ])("refuses %s", (_name, input) => {
    expect(contract.input.safeParse(input).success).toBe(false);
  });

  it("answers a memory with its uses and its memory PR", () => {
    const memory = {
      id: "mem_0a1b2c",
      label: null,
      summary: null,
      statement: "Use pnpm.",
      state: "retired",
      capture: "local_gateway",
      harness: "claude-code",
      agent: "agt.laptop",
      source: "claude-code:/home/dev/.claude/projects/-p/memory/a.md",
      repos: null,
      memory_type: null,
      kind: "memory",
      use_count: 1,
      use_signal: true,
      last_used_at: "2026-10-01T10:00:00.000Z",
      created_at: "2026-09-30T10:00:00.000Z",
      promoted_lineage: null,
      memory_pr: null,
      run: null,
      evidence: [],
      applies_to: null,
      tools: null,
      retired_at: "2026-10-01T11:00:00.000Z",
      retired_reason: "deleted",
    };
    expect(
      contract.output.safeParse({
        memory,
        uses: [
          { run: null, signal: "harness_count", count: 3, used_at: "2026-10-01T10:00:00.000Z" },
        ],
        uses_total: 1,
        memory_pr: null,
      }).success,
    ).toBe(true);
    expect(
      contract.output.safeParse({
        memory: { ...memory, retired_reason: "stale" },
        uses: [],
        uses_total: 0,
        memory_pr: null,
      }).success,
    ).toBe(false);
  });

  it("is a read the in-app agent never receives", () => {
    expect(contract.mutates).toBe(false);
    expect(contract.surfaces).not.toContain("agent");
  });
});
