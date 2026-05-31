import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { brandkitApplyHandler } from "./brandkit.apply.js";
import type { CapabilityContext } from "@oxagen/oxagen";

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

const BASE_INPUT = {
  workspaceId: "ws_1",
  brandKitId: "bk_abc",
  targetFileId: "file_xyz",
};

describe("brandkitApplyHandler", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a typed stub without throwing", async () => {
    const result = await brandkitApplyHandler(BASE_INPUT, CTX);

    expect(result.stub).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.brandKitId).toBe("bk_abc");
    expect(result.targetFileId).toBe("file_xyz");
  });

  it("logs the intent to console", async () => {
    const spy = vi.spyOn(console, "log");
    await brandkitApplyHandler(BASE_INPUT, CTX);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("[stub] brandkit.apply"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("bk_abc"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("file_xyz"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("ws_1"));
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
