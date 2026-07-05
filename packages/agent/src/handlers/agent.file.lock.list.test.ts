import { describe, it, expect, vi, beforeEach } from "vitest";

const onto = vi.hoisted(() => ({ listFileLocks: vi.fn() }));
vi.mock("@oxagen/ontology", () => ({ listFileLocks: onto.listFileLocks }));

import { agentFileLockListHandler } from "./agent.file.lock.list";
import { TEST_CTX } from "../test-utils/fixtures";

describe("agentFileLockListHandler", () => {
  beforeEach(() => {
    onto.listFileLocks.mockReset().mockResolvedValue({ locks: [] });
  });

  it("lists every live lock (naturalKey undefined) when no path filter is given", async () => {
    await agentFileLockListHandler({}, TEST_CTX);
    expect(onto.listFileLocks).toHaveBeenCalledWith({ naturalKey: undefined });
  });

  it("derives the naturalKey filter from path + owner + repo", async () => {
    await agentFileLockListHandler(
      { path: "src/a.ts", owner: "oxageninc", repo: "oxagen-platform" },
      TEST_CTX,
    );
    expect(onto.listFileLocks).toHaveBeenCalledWith({
      naturalKey: "github:oxageninc/oxagen-platform:src/a.ts",
    });
  });

  it("falls back to the raw path when owner/repo are omitted", async () => {
    await agentFileLockListHandler({ path: "src/a.ts" }, TEST_CTX);
    expect(onto.listFileLocks).toHaveBeenCalledWith({ naturalKey: "src/a.ts" });
  });

  it("returns the mutation's result as-is", async () => {
    const locks = [
      {
        lockId: "lock-1",
        naturalKey: "src/a.ts",
        agentId: "agent-a",
        acquiredAt: 1,
        expiresAt: 2,
        workspaceId: "ws-1",
        action: "write",
        executionId: "turn-1",
      },
    ];
    onto.listFileLocks.mockResolvedValue({ locks });
    const result = await agentFileLockListHandler({}, TEST_CTX);
    expect(result).toEqual({ locks });
  });
});
