import { describe, it, expect, vi, beforeEach } from "vitest";

const onto = vi.hoisted(() => ({ forceReleaseFileLock: vi.fn() }));
vi.mock("@oxagen/ontology", () => ({ forceReleaseFileLock: onto.forceReleaseFileLock }));

import { agentFileLockReleaseHandler } from "./agent.file.lock.release";
import { TEST_CTX } from "../test-utils/fixtures";

describe("agentFileLockReleaseHandler", () => {
  beforeEach(() => {
    onto.forceReleaseFileLock.mockReset().mockResolvedValue({ released: true });
  });

  it("delegates to forceReleaseFileLock (lockId only, no holder-identity check)", async () => {
    await agentFileLockReleaseHandler({ lockId: "lock-1" }, TEST_CTX);
    expect(onto.forceReleaseFileLock).toHaveBeenCalledWith({ lockId: "lock-1" });
  });

  it("returns the mutation's result as-is", async () => {
    onto.forceReleaseFileLock.mockResolvedValue({ released: false });
    const result = await agentFileLockReleaseHandler({ lockId: "lock-missing" }, TEST_CTX);
    expect(result).toEqual({ released: false });
  });
});
