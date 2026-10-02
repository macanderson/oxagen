import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { steeringMemoryPrRecordDrop } from "./steering.memory_pr_records.drop";

describe("drop_memory_record contract", () => {
  it("registers under its own name", () => {
    expect(getCapability("drop_memory_record")).toBe(steeringMemoryPrRecordDrop);
  });

  it("is a write for members on the api, mcp, and cli surfaces", () => {
    expect(steeringMemoryPrRecordDrop.mutates).toBe(true);
    expect(steeringMemoryPrRecordDrop.noBillingGate).toBe(true);
    expect(steeringMemoryPrRecordDrop.defaultEffect).toBe("deny");
    expect(steeringMemoryPrRecordDrop.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow", Member: "allow" },
    });
    expect(steeringMemoryPrRecordDrop.surfaces).toEqual(["api", "mcp", "cli"]);
  });

  it("takes a memory PR number and one path", () => {
    const parse = (value: unknown) =>
      steeringMemoryPrRecordDrop.input.safeParse(value).success;
    expect(
      parse({ number: 12, path: "steering/memory/workspace/general/a.md" }),
    ).toBe(true);
    expect(parse({ number: 0, path: "a.md" })).toBe(false);
    expect(parse({ number: 12, path: "" })).toBe(false);
    expect(parse({ branch: "memory/2026-10-02", path: "a.md" })).toBe(false);
  });

  it("answers the commit and whether the file was already gone", () => {
    expect(
      steeringMemoryPrRecordDrop.output.safeParse({
        pull_request: {
          number: 12,
          url: "https://github.com/a/b/pull/12",
          branch: "memory/2026-10-02",
        },
        path: "steering/memory/workspace/general/a.md",
        lineage: "a",
        commit_sha: "abc1234",
        already_dropped: false,
      }).success,
    ).toBe(true);
  });
});
