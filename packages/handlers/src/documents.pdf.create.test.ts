import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { documentsPdfCreateHandler } from "./documents.pdf.create";
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

describe("documentsPdfCreateHandler", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a typed stub without throwing", async () => {
    const result = await documentsPdfCreateHandler({ title: "Report" }, CTX);

    expect(result.stub).toBe(true);
    expect(result.fileId).toMatch(/^stub_/);
    expect(result.url).toMatch(/^https:\/\/stub\.invalid\//);
  });

  it("logs the intent to console", async () => {
    const spy = vi.spyOn(console, "log");
    await documentsPdfCreateHandler(
      { title: "Report", sourceHtml: "<h1>Hello</h1>" },
      CTX,
    );

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("[stub] documents.pdf.create"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Report"));
  });

  it("includes sourceFileId in the log when provided", async () => {
    const spy = vi.spyOn(console, "log");
    await documentsPdfCreateHandler(
      { title: "Export", sourceFileId: "file_xyz" },
      CTX,
    );

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("file_xyz"));
  });

  it("also logs brandkit.apply intent when brandKitId is supplied", async () => {
    const spy = vi.spyOn(console, "log");
    await documentsPdfCreateHandler(
      { title: "Branded", brandKitId: "bk_123" },
      CTX,
    );

    const calls = spy.mock.calls.flat().join("\n");
    expect(calls).toContain("[stub] brandkit.apply bk_123 ->");
  });

  it("does NOT log brandkit.apply when brandKitId is absent", async () => {
    const spy = vi.spyOn(console, "log");
    await documentsPdfCreateHandler({ title: "Plain" }, CTX);

    const calls = spy.mock.calls.flat().join("\n");
    expect(calls).not.toContain("[stub] brandkit.apply");
  });

  it("never throws even with minimal input", async () => {
    await expect(
      documentsPdfCreateHandler({ title: "Min" }, CTX),
    ).resolves.not.toThrow();
  });
});
