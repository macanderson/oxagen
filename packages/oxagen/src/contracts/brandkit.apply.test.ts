import { describe, expect, it } from "vitest";
import { brandkitApply } from "./brandkit.apply.js";

describe("brandkit.apply capability", () => {
  it("parses a valid input", () => {
    const parsed = brandkitApply.input.parse({
      workspaceId: "ws_1",
      brandKitId: "bk_abc",
      targetFileId: "file_xyz",
    });
    expect(parsed.workspaceId).toBe("ws_1");
    expect(parsed.brandKitId).toBe("bk_abc");
    expect(parsed.targetFileId).toBe("file_xyz");
  });

  it("rejects an empty workspaceId", () => {
    expect(() =>
      brandkitApply.input.parse({
        workspaceId: "",
        brandKitId: "bk_abc",
        targetFileId: "file_xyz",
      }),
    ).toThrow();
  });

  it("rejects an empty brandKitId", () => {
    expect(() =>
      brandkitApply.input.parse({
        workspaceId: "ws_1",
        brandKitId: "",
        targetFileId: "file_xyz",
      }),
    ).toThrow();
  });

  it("rejects an empty targetFileId", () => {
    expect(() =>
      brandkitApply.input.parse({
        workspaceId: "ws_1",
        brandKitId: "bk_abc",
        targetFileId: "",
      }),
    ).toThrow();
  });

  it("parses a valid stub output", () => {
    const parsed = brandkitApply.output.parse({
      stub: true,
      applied: false,
      brandKitId: "bk_abc",
      targetFileId: "file_xyz",
    });
    expect(parsed.stub).toBe(true);
    expect(parsed.applied).toBe(false);
    expect(parsed.brandKitId).toBe("bk_abc");
    expect(parsed.targetFileId).toBe("file_xyz");
  });

  it("rejects output where applied is not false", () => {
    expect(() =>
      brandkitApply.output.parse({
        stub: true,
        applied: true,
        brandKitId: "bk_abc",
        targetFileId: "file_xyz",
      }),
    ).toThrow();
  });

  it("rejects output where stub is not true", () => {
    expect(() =>
      brandkitApply.output.parse({
        stub: false,
        applied: false,
        brandKitId: "bk_abc",
        targetFileId: "file_xyz",
      }),
    ).toThrow();
  });
});
