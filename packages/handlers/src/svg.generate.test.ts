import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  generateObjectFor: vi.fn(),
  persistGeneratedAsset: vi.fn(),
}));

vi.mock("@oxagen/ai", () => ({
  generateObjectFor: mocks.generateObjectFor,
  // Prompt-registry wiring (svg.generate now resolves its system prompt through
  // the registry so workspace overrides/append apply). Passthrough in tests.
  loadWorkspacePromptConfig: vi.fn(async () => ({})),
  loadWorkspacePromptConfigSafe: vi.fn(async () => ({})),
  resolvePrompt: (a: { baseline: string }) => a.baseline,
  svgGeneratePrompt: (w: number, h: number) => `svg baseline ${w}x${h}`,
  enhancePromptIfInsufficient: vi.fn(async (a: { prompt: string }) => ({
    prompt: a.prompt,
    enhanced: false,
  })),
  defaultModel: vi.fn(() => "anthropic/test-model"),
  modelIdOf: vi.fn((m: string) => m),
}));

// Persistence seam — the handler persists the sanitized SVG as a conversation
// file through persistGeneratedAsset (mocked; the seam has its own tests).
vi.mock("./generated-asset.persist", () => ({
  persistGeneratedAsset: mocks.persistGeneratedAsset,
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── import under test ─────────────────────────────────────────────────────────

import { svgGenerateHandler } from "./svg.generate";

// ── fixtures ──────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

const VALID_SVG =
  '<svg viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg"><circle cx="200" cy="200" r="100" fill="currentColor"/></svg>';

// ─────────────────────────────────────────────────────────────────────────────

describe("svgGenerateHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: persistence succeeds.
    mocks.persistGeneratedAsset.mockResolvedValue({
      id: "uuid-1",
      publicId: "gen_abc123",
      kind: "image",
      mimeType: "image/svg+xml",
      sizeBytes: 123,
      key: "generated/images/org_1/x.svg",
      url: "blob://x",
      serveUrl: "/api/v1/assets/gen_abc123",
    });
  });

  it("returns svg, title and a render directive on success", async () => {
    mocks.generateObjectFor.mockResolvedValueOnce({
      object: { svg: VALID_SVG, title: "A Blue Circle" },
      usage: { promptTokens: 20, completionTokens: 80, totalTokens: 100 },
    });

    const result = await svgGenerateHandler({ prompt: "A blue circle" }, CTX);

    expect(result.svg).toContain("<svg");
    expect(result.title).toBe("A Blue Circle");
    expect(result.render.componentId).toBe("svg-preview");
    expect(result.render.props["svg"]).toBe(result.svg);
    expect(result.render.props["title"]).toBe("A Blue Circle");
  });

  it("strips <script> tags from the model output", async () => {
    const maliciousSvg =
      '<svg viewBox="0 0 400 400"><script>alert(1)</script><circle r="50" fill="currentColor"/></svg>';
    mocks.generateObjectFor.mockResolvedValueOnce({
      object: { svg: maliciousSvg, title: "Malicious" },
      usage: { promptTokens: 10, completionTokens: 50, totalTokens: 60 },
    });

    const result = await svgGenerateHandler({ prompt: "test" }, CTX);

    expect(result.svg).not.toContain("<script");
    expect(result.svg).not.toContain("alert(1)");
    expect(result.svg).toContain("<circle");
  });

  it("strips on* event handler attributes from the model output", async () => {
    const maliciousSvg =
      '<svg viewBox="0 0 400 400"><rect onclick="evil()" width="100" height="100"/></svg>';
    mocks.generateObjectFor.mockResolvedValueOnce({
      object: { svg: maliciousSvg, title: "Evil Rect" },
      usage: { promptTokens: 10, completionTokens: 50, totalTokens: 60 },
    });

    const result = await svgGenerateHandler({ prompt: "test" }, CTX);

    expect(result.svg).not.toContain("onclick");
    expect(result.svg).not.toContain("evil()");
    expect(result.svg).toContain("<rect");
  });

  it("returns a placeholder SVG and does not throw when model errors", async () => {
    mocks.generateObjectFor.mockRejectedValueOnce(
      new Error("Model unavailable"),
    );

    const result = await svgGenerateHandler(
      { prompt: "A mountain", title: "Mountain" },
      CTX,
    );

    // Handler must not throw — it returns a valid fallback.
    expect(result.svg).toContain("<svg");
    expect(result.title).toBe("Mountain");
    expect(result.render.componentId).toBe("svg-preview");
  });

  // ── Conversation-file persistence ───────────────────────────────────────────

  it("persists the sanitized SVG as an org-visible conversation file", async () => {
    mocks.generateObjectFor.mockResolvedValueOnce({
      object: { svg: VALID_SVG, title: "Circle" },
      usage: { promptTokens: 5, completionTokens: 20, totalTokens: 25 },
    });

    const result = await svgGenerateHandler(
      { prompt: "A blue circle" },
      { ...CTX, messageId: "msg_42" },
    );

    expect(mocks.persistGeneratedAsset).toHaveBeenCalledTimes(1);
    const args = mocks.persistGeneratedAsset.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(args["orgId"]).toBe("org_1");
    expect(args["workspaceId"]).toBe("ws_1");
    expect(args["userId"]).toBe("u_1");
    expect(args["kind"]).toBe("image");
    expect(args["mimeType"]).toBe("image/svg+xml");
    expect(args["accessPolicy"]).toBe("org");
    expect(args["prompt"]).toBe("A blue circle");
    expect(args["displayName"]).toBe("Circle");
    expect(args["messageId"]).toBe("msg_42");
    // Bytes are the SANITIZED markup, UTF-8 encoded.
    expect(new TextDecoder().decode(args["bytes"] as Uint8Array)).toBe(
      result.svg,
    );

    // Output + render directive carry the persisted asset reference.
    expect(result.assetPublicId).toBe("gen_abc123");
    expect(result.serveUrl).toBe("/api/v1/assets/gen_abc123");
    expect(result.persistWarning).toBeUndefined();
    expect(result.render.props["serveUrl"]).toBe("/api/v1/assets/gen_abc123");
    expect(result.render.props["assetPublicId"]).toBe("gen_abc123");
  });

  it("persistence failure is non-fatal: inline result returned with persistWarning", async () => {
    mocks.generateObjectFor.mockResolvedValueOnce({
      object: { svg: VALID_SVG, title: "Circle" },
      usage: { promptTokens: 5, completionTokens: 20, totalTokens: 25 },
    });
    mocks.persistGeneratedAsset.mockRejectedValueOnce(
      new Error("blob storage down"),
    );

    const result = await svgGenerateHandler({ prompt: "A blue circle" }, CTX);

    // Generation output is fully intact.
    expect(result.svg).toContain("<svg");
    expect(result.render.componentId).toBe("svg-preview");
    // No asset reference, but a user-visible warning.
    expect(result.assetPublicId).toBeUndefined();
    expect(result.serveUrl).toBeUndefined();
    expect(result.persistWarning).toContain("could not be saved");
    expect(result.render.props["serveUrl"]).toBeUndefined();
  });

  it("skips persistence with a warning when there is no user identity", async () => {
    mocks.generateObjectFor.mockResolvedValueOnce({
      object: { svg: VALID_SVG, title: "Circle" },
      usage: { promptTokens: 5, completionTokens: 20, totalTokens: 25 },
    });

    const result = await svgGenerateHandler(
      { prompt: "test" },
      { ...CTX, userId: null },
    );

    expect(mocks.persistGeneratedAsset).not.toHaveBeenCalled();
    expect(result.persistWarning).toContain("no user identity");
    expect(result.svg).toContain("<svg");
  });

  it("does not persist the failure-placeholder SVG", async () => {
    mocks.generateObjectFor.mockRejectedValueOnce(
      new Error("Model unavailable"),
    );

    const result = await svgGenerateHandler({ prompt: "A mountain" }, CTX);

    expect(mocks.persistGeneratedAsset).not.toHaveBeenCalled();
    expect(result.assetPublicId).toBeUndefined();
    expect(result.serveUrl).toBeUndefined();
  });

  it("falls back to requestId when messageId is null", async () => {
    let capturedTelemetry: Record<string, unknown> | null = null;
    mocks.generateObjectFor.mockImplementationOnce(
      (args: { telemetry: Record<string, unknown> }) => {
        capturedTelemetry = args.telemetry;
        return Promise.resolve({
          object: { svg: VALID_SVG, title: "Test" },
          usage: { promptTokens: 5, completionTokens: 20, totalTokens: 25 },
        });
      },
    );

    await svgGenerateHandler({ prompt: "test" }, { ...CTX, messageId: null });

    expect(capturedTelemetry?.["messageId"]).toBe("req_1");
  });

  it("forwards telemetry context to generateObjectFor", async () => {
    let capturedTelemetry: Record<string, unknown> | null = null;
    mocks.generateObjectFor.mockImplementationOnce(
      (args: { telemetry: Record<string, unknown> }) => {
        capturedTelemetry = args.telemetry;
        return Promise.resolve({
          object: { svg: VALID_SVG, title: "T" },
          usage: { promptTokens: 5, completionTokens: 20, totalTokens: 25 },
        });
      },
    );

    await svgGenerateHandler(
      { prompt: "test" },
      { ...CTX, messageId: "msg_1" },
    );

    expect(capturedTelemetry?.["orgId"]).toBe("org_1");
    expect(capturedTelemetry?.["workspaceId"]).toBe("ws_1");
    expect(capturedTelemetry?.["messageId"]).toBe("msg_1");
    expect(capturedTelemetry?.["surface"]).toBe("api");
  });

  it("passes width and height defaults when not provided", async () => {
    let capturedPrompt: string | undefined;
    mocks.generateObjectFor.mockImplementationOnce(
      (args: { system: string }) => {
        capturedPrompt = args.system;
        return Promise.resolve({
          object: { svg: VALID_SVG, title: "Default" },
          usage: { promptTokens: 5, completionTokens: 20, totalTokens: 25 },
        });
      },
    );

    await svgGenerateHandler({ prompt: "test" }, CTX);

    // The system prompt should reference the default 400×400 dimensions.
    expect(capturedPrompt).toContain("400");
  });
});
