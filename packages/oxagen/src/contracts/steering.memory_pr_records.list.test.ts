import { describe, expect, it } from "vitest";
import { steeringMemoryPrRecordsList as contract } from "./steering.memory_pr_records.list";

// list_memory_pr_records (memory-collection spec, Capabilities; #4912).
describe("list_memory_pr_records contract", () => {
  it("takes the memory PR's number", () => {
    expect(contract.input.parse({ number: 12 })).toEqual({ number: 12 });
  });

  it.each([
    ["no number", {}],
    ["number zero", { number: 0 }],
    ["a branch", { branch: "memory/2026-10-01" }],
  ])("refuses %s", (_name, input) => {
    expect(contract.input.safeParse(input).success).toBe(false);
  });

  it("answers each record with its memories and whether it was dropped", () => {
    expect(
      contract.output.safeParse({
        pull_request: {
          id: "mpr_0a1b2c",
          number: 12,
          url: "https://github.com/acme/steering/pull/12",
          repository: "acme/steering",
          branch: "memory/2026-10-01",
          status: "open",
          opened_at: "2026-10-01T09:00:00.000Z",
          settled_at: null,
        },
        branch_read: true,
        records: [
          {
            action: "propose",
            path: "steering/memory/workspace/general/use-pnpm.md",
            lineage: "use-pnpm",
            kind: "memory",
            title: "Use pnpm",
            summary: "Use pnpm.",
            memories: [
              {
                id: "mem_0a1b2c",
                statement: "Use pnpm.",
                agent: null,
                run: "tse_a1b2c3",
                evidence: ["frame:tse_a1b2c3/4"],
                state: "in_pr",
              },
            ],
            dropped: { commit_sha: "abc123" },
          },
          {
            action: "retire",
            path: "steering/memory/workspace/general/old.md",
            lineage: "old",
            kind: "memory",
            title: "old",
            summary: "old",
            memories: [],
            dropped: null,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("is a read on the api and mcp surfaces only", () => {
    expect(contract.mutates).toBe(false);
    expect(contract.surfaces).toEqual(["api", "mcp"]);
  });
});
