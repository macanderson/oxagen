import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  convSelect: vi.fn(),
  assetSelect: vi.fn(),
  callCount: { value: 0 },
}));

// Each withTenantDb call dispatches to either the conversation lookup or the
// asset query depending on the order of invocation.
mocks.convSelect.mockResolvedValue([]);
mocks.assetSelect.mockResolvedValue([]);

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();

  const makeChain = (leaf: () => Promise<unknown>) => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: leaf,
          orderBy: () => ({
            limit: leaf,
          }),
        }),
      }),
    }),
  });

  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      mocks.callCount.value += 1;
      // First call resolves the conversation; second resolves assets.
      const leaf =
        mocks.callCount.value === 1 ? mocks.convSelect : mocks.assetSelect;
      return fn(makeChain(leaf));
    },
  };
});

import { conversationFilesListHandler } from "./conversation.files.list";
import type { CapabilityContext } from "@oxagen/oxagen";
import { TEST_CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

const BASE_INPUT = {
  conversationId: "cnv_abc",
  kind: undefined as
    | "image"
    | "video"
    | "document"
    | "spreadsheet"
    | "presentation"
    | "pdf"
    | "archive"
    | undefined,
  limit: 50,
  cursor: null,
};

const CONV_ROW = {
  id: "int-conv-id",
  orgId: "org_1",
  userId: "u_1",
};

const makeAssetRow = (overrides: Record<string, unknown> = {}) => ({
  publicId: "gen_abc123",
  kind: "image",
  mimeType: "image/webp",
  sizeBytes: BigInt(204800),
  status: "ready",
  accessPolicy: "org",
  userId: "u_1",
  prompt: "A sunset over the ocean",
  createdAt: new Date("2024-06-01T12:00:00.000Z"),
  ...overrides,
});

describe("conversationFilesListHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callCount.value = 0;
    mocks.convSelect.mockResolvedValue([]);
    mocks.assetSelect.mockResolvedValue([]);
  });

  // ── auth guard ────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...TEST_CTX, userId: null };
    await expect(
      conversationFilesListHandler(BASE_INPUT, anonCtx),
    ).rejects.toThrow("conversation.files.list requires an authenticated user");
  });

  // ── conversation not found ────────────────────────────────────────────────

  it("throws when the conversation is not found in org scope", async () => {
    mocks.convSelect.mockResolvedValueOnce([]); // no conv row
    await expect(
      conversationFilesListHandler(BASE_INPUT, TEST_CTX),
    ).rejects.toThrow("conversation.files.list: conversation not found");
  });

  // ── empty assets ──────────────────────────────────────────────────────────

  it("returns empty files and null nextCursor when no assets exist", async () => {
    mocks.convSelect.mockResolvedValueOnce([CONV_ROW]);
    mocks.assetSelect.mockResolvedValueOnce([]);
    const result = await conversationFilesListHandler(BASE_INPUT, TEST_CTX);
    expect(result.files).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("maps asset rows to ConversationAssetItem shape", async () => {
    mocks.convSelect.mockResolvedValueOnce([CONV_ROW]);
    mocks.assetSelect.mockResolvedValueOnce([makeAssetRow()]);

    const result = await conversationFilesListHandler(BASE_INPUT, TEST_CTX);
    expect(result.files).toHaveLength(1);

    const file = result.files[0]!;
    expect(file.publicId).toBe("gen_abc123");
    expect(file.kind).toBe("image");
    expect(file.mimeType).toBe("image/webp");
    expect(file.sizeBytes).toBe(204800);
    expect(file.status).toBe("ready");
    expect(file.accessPolicy).toBe("org");
    expect(file.createdAt).toBe("2024-06-01T12:00:00.000Z");
    expect(file.url).toBe("/api/v1/assets/gen_abc123");
  });

  it("converts BigInt sizeBytes to number", async () => {
    mocks.convSelect.mockResolvedValueOnce([CONV_ROW]);
    mocks.assetSelect.mockResolvedValueOnce([
      makeAssetRow({ sizeBytes: BigInt(1048576) }),
    ]);
    const result = await conversationFilesListHandler(BASE_INPUT, TEST_CTX);
    expect(result.files[0]?.sizeBytes).toBe(1048576);
    expect(typeof result.files[0]?.sizeBytes).toBe("number");
  });

  it("returns null sizeBytes when null", async () => {
    mocks.convSelect.mockResolvedValueOnce([CONV_ROW]);
    mocks.assetSelect.mockResolvedValueOnce([
      makeAssetRow({ sizeBytes: null }),
    ]);
    const result = await conversationFilesListHandler(BASE_INPUT, TEST_CTX);
    expect(result.files[0]?.sizeBytes).toBeNull();
  });

  // ── access-policy filter ──────────────────────────────────────────────────

  it("includes 'user'-policy assets belonging to the calling user", async () => {
    mocks.convSelect.mockResolvedValueOnce([CONV_ROW]);
    mocks.assetSelect.mockResolvedValueOnce([
      makeAssetRow({ accessPolicy: "user", userId: TEST_CTX.userId }),
    ]);
    const result = await conversationFilesListHandler(BASE_INPUT, TEST_CTX);
    expect(result.files).toHaveLength(1);
  });

  it("excludes 'user'-policy assets belonging to a different user", async () => {
    mocks.convSelect.mockResolvedValueOnce([CONV_ROW]);
    mocks.assetSelect.mockResolvedValueOnce([
      makeAssetRow({ accessPolicy: "user", userId: "u_other" }),
    ]);
    const result = await conversationFilesListHandler(BASE_INPUT, TEST_CTX);
    expect(result.files).toHaveLength(0);
  });

  it("includes 'org'-policy assets for any org member", async () => {
    mocks.convSelect.mockResolvedValueOnce([CONV_ROW]);
    mocks.assetSelect.mockResolvedValueOnce([
      makeAssetRow({ accessPolicy: "org", userId: "u_other" }),
    ]);
    const result = await conversationFilesListHandler(BASE_INPUT, TEST_CTX);
    expect(result.files).toHaveLength(1);
  });

  it("includes 'public'-policy assets regardless of creator", async () => {
    mocks.convSelect.mockResolvedValueOnce([CONV_ROW]);
    mocks.assetSelect.mockResolvedValueOnce([
      makeAssetRow({ accessPolicy: "public", userId: "u_other" }),
    ]);
    const result = await conversationFilesListHandler(BASE_INPUT, TEST_CTX);
    expect(result.files).toHaveLength(1);
  });

  // ── name derivation (url-friendly slug WITH a file extension) ──────────────
  //
  // The user requires human-readable, lowercase-hyphenated filenames that always
  // carry the full extension. Derivation lives in lib/asset-filename.ts (unit-
  // tested there); these assert the handler wires the prompt/kind/mime/metadata
  // through to it correctly.

  it("renders a lowercase-hyphenated slug + mimeType extension for an image", async () => {
    mocks.convSelect.mockResolvedValueOnce([CONV_ROW]);
    mocks.assetSelect.mockResolvedValueOnce([
      makeAssetRow({
        kind: "image",
        mimeType: "image/png",
        prompt: "A sunset over the ocean",
      }),
    ]);
    const result = await conversationFilesListHandler(BASE_INPUT, TEST_CTX);
    expect(result.files[0]?.name).toBe("a-sunset-over-the-ocean.png");
  });

  it("uses the precise mimeType extension over the kind fallback (.webp)", async () => {
    mocks.convSelect.mockResolvedValueOnce([CONV_ROW]);
    mocks.assetSelect.mockResolvedValueOnce([
      makeAssetRow({
        kind: "image",
        mimeType: "image/webp",
        prompt: "A sunset over the ocean",
      }),
    ]);
    const result = await conversationFilesListHandler(BASE_INPUT, TEST_CTX);
    expect(result.files[0]?.name).toBe("a-sunset-over-the-ocean.webp");
  });

  it("strips a leading instruction verb from the prompt (.md)", async () => {
    mocks.convSelect.mockResolvedValueOnce([CONV_ROW]);
    mocks.assetSelect.mockResolvedValueOnce([
      makeAssetRow({
        kind: "document",
        mimeType: "text/markdown",
        prompt: "Generate markdown: USS Nautilus: The First Nuclear Submarine",
      }),
    ]);
    const result = await conversationFilesListHandler(BASE_INPUT, TEST_CTX);
    expect(result.files[0]?.name).toBe(
      "uss-nautilus-the-first-nuclear-submarine.md",
    );
  });

  it("prefers a clean metadata.displayName over the noisy prompt", async () => {
    mocks.convSelect.mockResolvedValueOnce([CONV_ROW]);
    mocks.assetSelect.mockResolvedValueOnce([
      makeAssetRow({
        kind: "document",
        mimeType: "text/markdown",
        prompt: "Generate markdown: ignore me",
        metadata: { displayName: "Polar Crossing Report" },
      }),
    ]);
    const result = await conversationFilesListHandler(BASE_INPUT, TEST_CTX);
    expect(result.files[0]?.name).toBe("polar-crossing-report.md");
  });

  it("slugs office document mimeTypes with the right extension", async () => {
    mocks.convSelect.mockResolvedValueOnce([CONV_ROW]);
    mocks.assetSelect.mockResolvedValueOnce([
      makeAssetRow({
        publicId: "gen_doc1",
        kind: "document",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        prompt: "Onboarding checklist",
      }),
      makeAssetRow({
        publicId: "gen_sheet1",
        kind: "spreadsheet",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        prompt: "Budget plan",
        createdAt: new Date("2024-06-01T11:00:00.000Z"),
      }),
      makeAssetRow({
        publicId: "gen_deck1",
        kind: "presentation",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        prompt: "Kickoff deck",
        createdAt: new Date("2024-06-01T10:00:00.000Z"),
      }),
    ]);
    const result = await conversationFilesListHandler(BASE_INPUT, TEST_CTX);
    const names = result.files.map((f) => f.name);
    expect(names).toContain("onboarding-checklist.docx");
    expect(names).toContain("budget-plan.xlsx");
    expect(names).toContain("kickoff-deck.pptx");
  });

  it("falls back to the kind extension when the mimeType is unknown", async () => {
    mocks.convSelect.mockResolvedValueOnce([CONV_ROW]);
    mocks.assetSelect.mockResolvedValueOnce([
      makeAssetRow({
        kind: "archive",
        mimeType: "application/octet-stream",
        prompt: "Project export",
      }),
    ]);
    const result = await conversationFilesListHandler(BASE_INPUT, TEST_CTX);
    // archive kind → .zip fallback.
    expect(result.files[0]?.name).toBe("project-export.zip");
  });

  it("falls back to 'kind-<last 8 chars of publicId>.<ext>' when prompt is empty", async () => {
    mocks.convSelect.mockResolvedValueOnce([CONV_ROW]);
    mocks.assetSelect.mockResolvedValueOnce([
      // publicId "gen_image_abc12345" → last 8 chars = "_abc12345".slice(-8) = "abc12345".
      makeAssetRow({
        kind: "image",
        mimeType: "image/png",
        prompt: "",
        publicId: "gen_image_abc12345",
      }),
    ]);
    const result = await conversationFilesListHandler(BASE_INPUT, TEST_CTX);
    expect(result.files[0]?.name).toBe("image-abc12345.png");
  });

  it("truncates a long prompt slug to ≤60 chars, then appends the extension", async () => {
    mocks.convSelect.mockResolvedValueOnce([CONV_ROW]);
    const longPrompt = "word ".repeat(40);
    mocks.assetSelect.mockResolvedValueOnce([
      makeAssetRow({
        kind: "image",
        mimeType: "image/png",
        prompt: longPrompt,
      }),
    ]);
    const result = await conversationFilesListHandler(BASE_INPUT, TEST_CTX);
    const name = result.files[0]!.name;
    expect(name.endsWith(".png")).toBe(true);
    const base = name.slice(0, name.length - ".png".length);
    expect(base.length).toBeLessThanOrEqual(60);
    expect(base.endsWith("-")).toBe(false);
  });

  // ── pagination ────────────────────────────────────────────────────────────

  it("returns nextCursor when visible rows exceed limit", async () => {
    mocks.convSelect.mockResolvedValueOnce([CONV_ROW]);
    // 3 visible rows, limit=2 → cursor = rows[1].createdAt
    const rows = [
      makeAssetRow({
        publicId: "gen_1",
        createdAt: new Date("2024-06-03T00:00:00.000Z"),
      }),
      makeAssetRow({
        publicId: "gen_2",
        createdAt: new Date("2024-06-02T00:00:00.000Z"),
      }),
      makeAssetRow({
        publicId: "gen_3",
        createdAt: new Date("2024-06-01T00:00:00.000Z"),
      }),
    ];
    mocks.assetSelect.mockResolvedValueOnce(rows);

    const result = await conversationFilesListHandler(
      { ...BASE_INPUT, limit: 2 },
      TEST_CTX,
    );
    expect(result.files).toHaveLength(2);
    expect(result.files[0]?.publicId).toBe("gen_1");
    expect(result.files[1]?.publicId).toBe("gen_2");
    expect(result.nextCursor).toBe("2024-06-02T00:00:00.000Z");
  });

  it("returns null nextCursor on the last page", async () => {
    mocks.convSelect.mockResolvedValueOnce([CONV_ROW]);
    mocks.assetSelect.mockResolvedValueOnce([makeAssetRow()]);
    const result = await conversationFilesListHandler(
      { ...BASE_INPUT, limit: 2 },
      TEST_CTX,
    );
    expect(result.files).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  it("pagination accounts for access-policy filtering (other-user assets excluded)", async () => {
    mocks.convSelect.mockResolvedValueOnce([CONV_ROW]);
    // 3 rows returned; middle one excluded by access-policy → only 2 visible,
    // which is equal to limit=2, so nextCursor should be null.
    const rows = [
      makeAssetRow({
        publicId: "gen_1",
        accessPolicy: "org",
        createdAt: new Date("2024-06-03T00:00:00.000Z"),
      }),
      makeAssetRow({
        publicId: "gen_hidden",
        accessPolicy: "user",
        userId: "u_other",
        createdAt: new Date("2024-06-02T00:00:00.000Z"),
      }),
      makeAssetRow({
        publicId: "gen_2",
        accessPolicy: "org",
        createdAt: new Date("2024-06-01T00:00:00.000Z"),
      }),
    ];
    mocks.assetSelect.mockResolvedValueOnce(rows);

    const result = await conversationFilesListHandler(
      { ...BASE_INPUT, limit: 2 },
      TEST_CTX,
    );
    expect(result.files.map((f) => f.publicId)).toEqual(["gen_1", "gen_2"]);
    expect(result.nextCursor).toBeNull();
  });

  // ── tenant scope ──────────────────────────────────────────────────────────

  it("invokes withTenantDb twice (conv lookup + asset query)", async () => {
    mocks.convSelect.mockResolvedValueOnce([CONV_ROW]);
    mocks.assetSelect.mockResolvedValueOnce([]);
    await conversationFilesListHandler(BASE_INPUT, TEST_CTX);
    expect(mocks.callCount.value).toBe(2);
  });
});
