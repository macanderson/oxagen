import { describe, expect, it } from "vitest";
import { agentFileLockList } from "./agent.file_lock.list";
import { getCapability } from "../registry";

describe("agent.file.lock.list capability", () => {
  it("accepts an empty input (lists every live lock)", () => {
    expect(() => agentFileLockList.input.parse({})).not.toThrow();
  });

  it("accepts a path filter", () => {
    const parsed = agentFileLockList.input.parse({ path: "src/a.ts" });
    expect(parsed.path).toBe("src/a.ts");
  });

  it("parses a locks array output", () => {
    const parsed = agentFileLockList.output.parse({
      locks: [
        {
          lockId: "lock-1",
          naturalKey: "github:owner/repo:src/a.ts",
          agentId: "agent-a",
          acquiredAt: 1_700_000_000_000,
          expiresAt: 1_700_000_300_000,
          workspaceId: "ws-1",
          action: "write",
          executionId: "turn-1",
        },
      ],
    });
    expect(parsed.locks).toHaveLength(1);
  });

  it("parses an empty locks array", () => {
    expect(agentFileLockList.output.parse({ locks: [] })).toEqual({
      locks: [],
    });
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("list_file_locks")).toBe(agentFileLockList);
  });
});
