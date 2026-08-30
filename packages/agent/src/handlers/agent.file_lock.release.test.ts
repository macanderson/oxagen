import { describe, it, expect, vi, beforeEach } from "vitest";

const lease = vi.hoisted(() => ({ releaseFileLease: vi.fn() }));
vi.mock("../file-lock/lease", () => ({
  releaseFileLease: lease.releaseFileLease,
}));

import { agentFileLockReleaseHandler } from "./agent.file_lock.release";
import { TEST_CTX, makeCTX } from "../test-utils/fixtures";

describe("agentFileLockReleaseHandler", () => {
  beforeEach(() => {
    lease.releaseFileLease.mockReset().mockResolvedValue({ released: true });
  });

  it("force-releases by lockId only (no holder guard), scoped by ctx org/workspace", async () => {
    await agentFileLockReleaseHandler(
      { lockId: "lock-1" },
      makeCTX({ orgId: "org_1", workspaceId: "ws_1" }),
    );
    expect(lease.releaseFileLease).toHaveBeenCalledWith({
      orgId: "org_1",
      workspaceId: "ws_1",
      lockId: "lock-1",
    });
  });

  it("returns the lease service's result as-is", async () => {
    lease.releaseFileLease.mockResolvedValue({ released: false });
    const result = await agentFileLockReleaseHandler(
      { lockId: "lock-missing" },
      TEST_CTX,
    );
    expect(result).toEqual({ released: false });
  });
});
