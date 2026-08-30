import { describe, it, expect, vi, beforeEach } from "vitest";

const lease = vi.hoisted(() => ({ listFileLeases: vi.fn() }));
vi.mock("../file-lock/lease", () => ({ listFileLeases: lease.listFileLeases }));

import { agentFileLockListHandler } from "./agent.file_lock.list";
import { TEST_CTX, makeCTX } from "../test-utils/fixtures";

describe("agentFileLockListHandler", () => {
  beforeEach(() => {
    lease.listFileLeases.mockReset().mockResolvedValue({ leases: [] });
  });

  it("lists every live lock (resourceKey undefined) when no path filter is given", async () => {
    await agentFileLockListHandler(
      {},
      makeCTX({ orgId: "org_1", workspaceId: "ws_1" }),
    );
    expect(lease.listFileLeases).toHaveBeenCalledWith({
      orgId: "org_1",
      workspaceId: "ws_1",
      resourceKey: undefined,
    });
  });

  it("derives the resourceKey filter from path + owner + repo", async () => {
    await agentFileLockListHandler(
      { path: "src/a.ts", owner: "oxageninc", repo: "oxagen-platform" },
      TEST_CTX,
    );
    expect(lease.listFileLeases).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceKey: "github:oxageninc/oxagen-platform:src/a.ts",
      }),
    );
  });

  it("falls back to the raw path when owner/repo are omitted", async () => {
    await agentFileLockListHandler({ path: "src/a.ts" }, TEST_CTX);
    expect(lease.listFileLeases).toHaveBeenCalledWith(
      expect.objectContaining({ resourceKey: "src/a.ts" }),
    );
  });

  it("maps lease records to the contract's FileLockRecord shape (naturalKey = resourceKey, agentId = holder)", async () => {
    lease.listFileLeases.mockResolvedValue({
      leases: [
        {
          lockId: "lock-1",
          resourceKey: "src/a.ts",
          holder: "agent-a",
          executionId: "turn-1",
          action: "write",
          fencingToken: 3,
          acquiredAt: 1,
          expiresAt: 2,
        },
      ],
    });
    const result = await agentFileLockListHandler(
      {},
      makeCTX({ workspaceId: "ws-1" }),
    );
    expect(result).toEqual({
      locks: [
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
      ],
    });
  });
});
