import { describe, it, expect, vi, afterEach } from "vitest";
import { brandkitApplyHandler } from "./brandkit.apply";
import { logger } from "./logger";
import type { CapabilityContext } from "@oxagen/oxagen";

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

<<<<<<< HEAD
import { TEST_CTX as CTX } from "./test-utils/fixtures";
=======
const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};
>>>>>>> feat/hardening-cost-prompts-motion-rebrand

const BASE_INPUT = {
  workspaceId: "ws_1",
  brandKitId: "bk_abc",
  targetFileId: "file_xyz",
};

describe("brandkitApplyHandler", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns a typed stub without throwing", async () => {
    const result = await brandkitApplyHandler(BASE_INPUT, CTX);

    expect(result.stub).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.brandKitId).toBe("bk_abc");
    expect(result.targetFileId).toBe("file_xyz");
  });

  it("logs the stub invocation via the structured logger with PII-free identifiers", async () => {
    await brandkitApplyHandler(BASE_INPUT, CTX);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        brandKitId: "bk_abc",
        targetFileId: "file_xyz",
        workspaceId: "ws_1",
        stub: true,
      }),
      expect.stringContaining("brandkit.apply"),
    );
  });

  it("echoes brandKitId and targetFileId from input", async () => {
    const result = await brandkitApplyHandler(
      { workspaceId: "ws_other", brandKitId: "bk_brand", targetFileId: "file_doc" },
      CTX,
    );

    expect(result.brandKitId).toBe("bk_brand");
    expect(result.targetFileId).toBe("file_doc");
  });

  it("never throws", async () => {
    await expect(brandkitApplyHandler(BASE_INPUT, CTX)).resolves.not.toThrow();
  });
});
