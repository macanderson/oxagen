import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  persistGeneratedAsset: vi.fn(),
}));

// Mock logger — we don't test log output
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Persistence seam — the handler persists the .mmd diagram source as a
// conversation file through persistGeneratedAsset (mocked; the seam has its
// own tests).
vi.mock("./generated-asset.persist", () => ({
  persistGeneratedAsset: mocks.persistGeneratedAsset,
}));

import { mermaidGenerateHandler } from "./mermaid.generate";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

const VALID_DIAGRAM = "flowchart TD\n  A[Start] --> B[End]";

describe("mermaidGenerateHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: persistence succeeds.
    mocks.persistGeneratedAsset.mockResolvedValue({
      id: "uuid-1",
      publicId: "gen_mmd1",
      kind: "document",
      mimeType: "text/vnd.mermaid",
      sizeBytes: 42,
      key: "generated/documents/org_1/x.mmd",
      url: "blob://x",
      serveUrl: "/api/v1/assets/gen_mmd1",
    });
  });
  it("returns title, source, and render directive on success", async () => {
    const result = await mermaidGenerateHandler(
      { title: "My Flow", diagram: VALID_DIAGRAM },
      CTX,
    );

    expect(result.title).toBe("My Flow");
    expect(result.source).toBe(VALID_DIAGRAM);
    expect(result.render.componentId).toBe("mermaid-diagram");
    expect(result.render.props["source"]).toBe(VALID_DIAGRAM);
    expect(result.render.props["title"]).toBe("My Flow");
    expect(result.render.props["theme"]).toBe("default");
  });

  it("passes through an explicit theme", async () => {
    const result = await mermaidGenerateHandler(
      { title: "Dark Chart", diagram: VALID_DIAGRAM, theme: "dark" },
      CTX,
    );
    expect(result.render.props["theme"]).toBe("dark");
  });

  it("defaults theme to 'default' when not provided", async () => {
    const result = await mermaidGenerateHandler(
      { title: "T", diagram: VALID_DIAGRAM },
      CTX,
    );
    expect(result.render.props["theme"]).toBe("default");
  });

  it("throws when diagram is blank whitespace", async () => {
    await expect(
      mermaidGenerateHandler({ title: "T", diagram: "   " }, CTX),
    ).rejects.toThrow("blank");
  });

  it("throws when diagram exceeds 50,000 characters", async () => {
    await expect(
      mermaidGenerateHandler({ title: "T", diagram: "A".repeat(50_001) }, CTX),
    ).rejects.toThrow("50000");
  });

  it("accepts a diagram of exactly 50,000 characters", async () => {
    const longDiagram = "A".repeat(50_000);
    const result = await mermaidGenerateHandler(
      { title: "T", diagram: longDiagram },
      CTX,
    );
    expect(result.source).toBe(longDiagram);
  });

  it("passes source through unchanged", async () => {
    const source = "sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi";
    const result = await mermaidGenerateHandler(
      { title: "Seq", diagram: source },
      CTX,
    );
    expect(result.source).toBe(source);
  });

  // ── Conversation-file persistence ───────────────────────────────────────────

  it("persists the diagram source as a .mmd document conversation file", async () => {
    const result = await mermaidGenerateHandler(
      { title: "My Flow", diagram: VALID_DIAGRAM },
      { ...CTX, messageId: "msg_9" },
    );

    expect(mocks.persistGeneratedAsset).toHaveBeenCalledTimes(1);
    const args = mocks.persistGeneratedAsset.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(args["orgId"]).toBe("org_1");
    expect(args["workspaceId"]).toBe("ws_1");
    expect(args["userId"]).toBe("u_1");
    expect(args["kind"]).toBe("document");
    expect(args["mimeType"]).toBe("text/vnd.mermaid");
    expect(args["accessPolicy"]).toBe("org");
    expect(args["displayName"]).toBe("My Flow");
    expect(args["model"]).toBe("local");
    expect(args["messageId"]).toBe("msg_9");
    // Bytes are the raw diagram source, UTF-8 encoded.
    expect(new TextDecoder().decode(args["bytes"] as Uint8Array)).toBe(
      VALID_DIAGRAM,
    );

    // Output + render directive carry the persisted asset reference.
    expect(result.assetPublicId).toBe("gen_mmd1");
    expect(result.serveUrl).toBe("/api/v1/assets/gen_mmd1");
    expect(result.persistWarning).toBeUndefined();
    expect(result.render.props["sourceUrl"]).toBe("/api/v1/assets/gen_mmd1");
    expect(result.render.props["assetPublicId"]).toBe("gen_mmd1");
  });

  it("persistence failure is non-fatal: render directive returned with persistWarning", async () => {
    mocks.persistGeneratedAsset.mockRejectedValueOnce(new Error("db down"));

    const result = await mermaidGenerateHandler(
      { title: "My Flow", diagram: VALID_DIAGRAM },
      CTX,
    );

    // The inline render directive is fully intact.
    expect(result.render.componentId).toBe("mermaid-diagram");
    expect(result.source).toBe(VALID_DIAGRAM);
    // No asset reference, but a user-visible warning.
    expect(result.assetPublicId).toBeUndefined();
    expect(result.serveUrl).toBeUndefined();
    expect(result.persistWarning).toContain("could not be saved");
    expect(result.render.props["sourceUrl"]).toBeUndefined();
  });

  it("skips persistence with a warning when there is no user identity", async () => {
    const result = await mermaidGenerateHandler(
      { title: "My Flow", diagram: VALID_DIAGRAM },
      { ...CTX, userId: null },
    );

    expect(mocks.persistGeneratedAsset).not.toHaveBeenCalled();
    expect(result.persistWarning).toContain("no user identity");
    expect(result.render.componentId).toBe("mermaid-diagram");
  });
});
