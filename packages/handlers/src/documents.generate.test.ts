import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { documentsGenerateHandler } from "./documents.generate.js";
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

describe("documentsGenerateHandler", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a typed stub without throwing", async () => {
    const result = await documentsGenerateHandler(
      { provider: "google", kind: "document", title: "My Doc" },
      CTX,
    );

    expect(result.stub).toBe(true);
    expect(result.provider).toBe("google");
    expect(result.kind).toBe("document");
    expect(result.fileId).toMatch(/^stub_/);
    expect(result.url).toMatch(/^https:\/\/stub\.invalid\//);
  });

  it("logs the intent to console", async () => {
    const spy = vi.spyOn(console, "log");
    await documentsGenerateHandler(
      { provider: "microsoft", kind: "presentation", title: "Deck" },
      CTX,
    );

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("[stub] documents.generate"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("microsoft/presentation"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Deck"));
  });

  it("also logs brandkit.apply intent when brandKitId is supplied", async () => {
    const spy = vi.spyOn(console, "log");
    await documentsGenerateHandler(
      { provider: "google", kind: "spreadsheet", title: "Sheet", brandKitId: "bk_abc" },
      CTX,
    );

    const calls = spy.mock.calls.flat().join("\n");
    expect(calls).toContain("[stub] brandkit.apply bk_abc ->");
  });

  it("does NOT log brandkit.apply when brandKitId is absent", async () => {
    const spy = vi.spyOn(console, "log");
    await documentsGenerateHandler(
      { provider: "google", kind: "document", title: "No brand" },
      CTX,
    );

    const calls = spy.mock.calls.flat().join("\n");
    expect(calls).not.toContain("[stub] brandkit.apply");
  });

  it("never throws even with minimal input", async () => {
    await expect(
      documentsGenerateHandler({ provider: "google", kind: "document", title: "T" }, CTX),
    ).resolves.not.toThrow();
  });
});
