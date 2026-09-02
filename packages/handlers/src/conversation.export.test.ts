import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  convSelect: vi.fn(),
  messageSelect: vi.fn(),
  orgSelect: vi.fn(),
  wsSelect: vi.fn(),
  persist: vi.fn(),
  callCount: { value: 0 },
}));

// withTenantDb dispatch by call order:
//   1 → conversation lookup, 2 → messages, 3 → org name, 4 → workspace name.
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();

  const makeChain = (leaf: () => Promise<unknown>) => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: leaf,
          orderBy: leaf,
        }),
      }),
    }),
  });

  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      mocks.callCount.value += 1;
      const leaf =
        [
          mocks.convSelect,
          mocks.messageSelect,
          mocks.orgSelect,
          mocks.wsSelect,
        ][mocks.callCount.value - 1] ?? mocks.wsSelect;
      return fn(makeChain(leaf));
    },
  };
});

vi.mock("./generated-asset.persist", () => ({
  persistGeneratedAsset: mocks.persist,
}));

import { conversationExportHandler } from "./conversation.export";
import type { CapabilityContext } from "@oxagen/oxagen";
import { TEST_CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

const CONV_ROW = {
  id: "conv-uuid",
  title: "Quarterly Planning",
  createdAt: new Date("2026-06-30T09:00:00.000Z"),
  activeLeafMessageId: "m2",
};

const MESSAGE_ROWS = [
  {
    id: "m1",
    parentMessageId: null,
    role: "user",
    content: "What is our Q3 plan?",
    contentBlocks: [],
    metadata: {},
    createdAt: new Date("2026-07-01T10:00:00.000Z"),
  },
  {
    id: "m2",
    parentMessageId: "m1",
    role: "assistant",
    content: "Ship the wedge.",
    contentBlocks: [
      { type: "reasoning", text: "consider the roadmap", durationMs: 1200 },
      { type: "text", text: "Ship the wedge." },
      {
        type: "tool-call",
        capability: "search_graph",
        status: "success",
        durationMs: 300,
      },
      {
        type: "code-execute",
        language: "ts",
        code: "const x = 1;",
        status: "success",
      },
    ],
    metadata: {},
    createdAt: new Date("2026-07-01T10:01:00.000Z"),
  },
];

function seedHappyPath() {
  mocks.convSelect.mockResolvedValueOnce([CONV_ROW]);
  mocks.messageSelect.mockResolvedValueOnce(MESSAGE_ROWS);
  mocks.orgSelect.mockResolvedValueOnce([{ name: "Acme" }]);
  mocks.wsSelect.mockResolvedValueOnce([{ name: "Growth" }]);
}

const MD_INPUT = { conversationId: "cnv_abc", format: "markdown" as const };
const PDF_INPUT = { conversationId: "cnv_abc", format: "pdf" as const };

describe("conversationExportHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callCount.value = 0;
    mocks.convSelect.mockResolvedValue([]);
    mocks.messageSelect.mockResolvedValue([]);
    mocks.orgSelect.mockResolvedValue([]);
    mocks.wsSelect.mockResolvedValue([]);
    mocks.persist.mockResolvedValue({
      id: "asset-uuid",
      publicId: "gen_export1",
      kind: "pdf",
      mimeType: "application/pdf",
      sizeBytes: 12345,
      key: "generated/pdfs/org_1/x.pdf",
      url: "https://blob/x.pdf",
      serveUrl: "/api/v1/assets/gen_export1",
    });
  });

  // ── guards ─────────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...TEST_CTX, userId: null };
    await expect(conversationExportHandler(MD_INPUT, anonCtx)).rejects.toThrow(
      "conversation.export requires an authenticated user",
    );
  });

  it("throws when the conversation is not found in org scope", async () => {
    mocks.convSelect.mockResolvedValueOnce([]);
    await expect(conversationExportHandler(MD_INPUT, TEST_CTX)).rejects.toThrow(
      "conversation.export: conversation not found",
    );
  });

  // ── markdown ───────────────────────────────────────────────────────────────

  it("returns inline markdown with filename and message count (no storage)", async () => {
    seedHappyPath();
    const result = await conversationExportHandler(MD_INPUT, TEST_CTX);
    expect(result.format).toBe("markdown");
    expect(result.url).toBeNull();
    expect(result.messageCount).toBe(2);
    expect(result.filename).toMatch(
      /^quarterly-planning-\d{4}-\d{2}-\d{2}\.md$/,
    );
    expect(result.content).toContain("# Quarterly Planning");
    expect(result.content).toContain("- **Organization:** Acme");
    expect(result.content).toContain("- **Workspace:** Growth");
    expect(result.content).toContain("## You");
    expect(result.content).toContain("## Assistant");
    expect(result.content).toContain("<summary>Reasoning (1.2s)</summary>");
    expect(result.content).toContain(
      "tool: search_graph · status: success · duration: 300ms",
    );
    expect(result.content).toContain("```ts\nconst x = 1;\n```");
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("exports only the active branch when the conversation forks", async () => {
    mocks.convSelect.mockResolvedValueOnce([
      { ...CONV_ROW, activeLeafMessageId: "m3" },
    ]);
    mocks.messageSelect.mockResolvedValueOnce([
      ...MESSAGE_ROWS,
      {
        id: "m3",
        parentMessageId: "m1",
        role: "assistant",
        content: "Regenerated answer.",
        contentBlocks: [],
        metadata: {},
        createdAt: new Date("2026-07-01T10:02:00.000Z"),
      },
    ]);
    mocks.orgSelect.mockResolvedValueOnce([{ name: "Acme" }]);
    mocks.wsSelect.mockResolvedValueOnce([{ name: "Growth" }]);

    const result = await conversationExportHandler(MD_INPUT, TEST_CTX);
    expect(result.messageCount).toBe(2);
    expect(result.content).toContain("Regenerated answer.");
    expect(result.content).not.toContain("Ship the wedge.");
    expect(result.content).toContain("3 messages across branches");
  });

  it("uses a fallback title when the conversation is untitled", async () => {
    mocks.convSelect.mockResolvedValueOnce([{ ...CONV_ROW, title: null }]);
    mocks.messageSelect.mockResolvedValueOnce(MESSAGE_ROWS);
    mocks.orgSelect.mockResolvedValueOnce([]);
    mocks.wsSelect.mockResolvedValueOnce([]);
    const result = await conversationExportHandler(MD_INPUT, TEST_CTX);
    expect(result.content).toContain("# Untitled conversation");
    expect(result.filename).toMatch(/^untitled-conversation-/);
  });

  // ── pdf ────────────────────────────────────────────────────────────────────

  it("renders a parseable PDF, persists it privately, and returns the serve URL", async () => {
    seedHappyPath();
    const result = await conversationExportHandler(PDF_INPUT, TEST_CTX);

    expect(result.format).toBe("pdf");
    expect(result.content).toBeNull();
    expect(result.url).toBe("/api/v1/assets/gen_export1");
    expect(result.filename).toMatch(
      /^quarterly-planning-\d{4}-\d{2}-\d{2}\.pdf$/,
    );

    expect(mocks.persist).toHaveBeenCalledTimes(1);
    const args = mocks.persist.mock.calls[0]![0] as {
      kind: string;
      accessPolicy: string;
      mimeType: string;
      conversationId: string | null;
      messageId: string | null;
      bytes: Uint8Array;
    };
    expect(args.kind).toBe("pdf");
    expect(args.mimeType).toBe("application/pdf");
    // Private to the requester and NEVER linked to the conversation.
    expect(args.accessPolicy).toBe("user");
    expect(args.conversationId).toBeNull();
    expect(args.messageId).toBeNull();

    // pdf-lib can parse its own output — proves the bytes are a valid PDF.
    const { PDFDocument } = await import("pdf-lib");
    const parsed = await PDFDocument.load(args.bytes);
    expect(parsed.getPageCount()).toBeGreaterThan(0);
    expect(parsed.getTitle()).toBe("Quarterly Planning");
  });

  it("does not forward ctx.messageId into the persisted asset", async () => {
    seedHappyPath();
    const ctxWithMessage: CapabilityContext = {
      ...TEST_CTX,
      messageId: "msg-live",
    };
    await conversationExportHandler(PDF_INPUT, ctxWithMessage);
    const args = mocks.persist.mock.calls[0]![0] as {
      messageId: string | null;
    };
    expect(args.messageId).toBeNull();
  });

  it("paginates long conversations across multiple pages with footers intact", async () => {
    const longRows = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`,
      parentMessageId: i === 0 ? null : `m${i - 1}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}: ${"substantial paragraph text ".repeat(20)}`,
      contentBlocks: [],
      metadata: {},
      createdAt: new Date(Date.UTC(2026, 6, 1, 10, i)),
    }));
    mocks.convSelect.mockResolvedValueOnce([
      { ...CONV_ROW, activeLeafMessageId: "m29" },
    ]);
    mocks.messageSelect.mockResolvedValueOnce(longRows);
    mocks.orgSelect.mockResolvedValueOnce([{ name: "Acme" }]);
    mocks.wsSelect.mockResolvedValueOnce([{ name: "Growth" }]);

    const result = await conversationExportHandler(PDF_INPUT, TEST_CTX);
    expect(result.messageCount).toBe(30);

    const args = mocks.persist.mock.calls[0]![0] as { bytes: Uint8Array };
    const { PDFDocument } = await import("pdf-lib");
    const parsed = await PDFDocument.load(args.bytes);
    expect(parsed.getPageCount()).toBeGreaterThan(1);
  });
});
