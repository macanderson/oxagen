import { describe, expect, it } from "vitest";
import {
  conversationFilesList,
  conversationAssetKind,
  conversationAssetItem,
} from "./conversation.files.list";
import { getCapability } from "../registry";

describe("conversation.files.list capability", () => {
  // ── input defaults ────────────────────────────────────────────────────────

  it("defaults limit to 50", () => {
    const parsed = conversationFilesList.input.parse({
      conversationId: "cnv_1",
    });
    expect(parsed.limit).toBe(50);
  });

  it("defaults cursor to null", () => {
    const parsed = conversationFilesList.input.parse({
      conversationId: "cnv_1",
    });
    expect(parsed.cursor).toBeNull();
  });

  it("accepts an explicit null cursor", () => {
    const parsed = conversationFilesList.input.parse({
      conversationId: "cnv_1",
      cursor: null,
    });
    expect(parsed.cursor).toBeNull();
  });

  it("accepts a cursor ISO string", () => {
    const parsed = conversationFilesList.input.parse({
      conversationId: "cnv_1",
      cursor: "2024-06-01T12:00:00.000Z",
    });
    expect(parsed.cursor).toBe("2024-06-01T12:00:00.000Z");
  });

  // ── limit bounds ──────────────────────────────────────────────────────────

  it("accepts limit=1 (min)", () => {
    const parsed = conversationFilesList.input.parse({
      conversationId: "cnv_1",
      limit: 1,
    });
    expect(parsed.limit).toBe(1);
  });

  it("accepts limit=200 (max)", () => {
    const parsed = conversationFilesList.input.parse({
      conversationId: "cnv_1",
      limit: 200,
    });
    expect(parsed.limit).toBe(200);
  });

  it("rejects limit=0 (below min)", () => {
    expect(() =>
      conversationFilesList.input.parse({ conversationId: "cnv_1", limit: 0 }),
    ).toThrow();
  });

  it("rejects limit=201 (above max)", () => {
    expect(() =>
      conversationFilesList.input.parse({
        conversationId: "cnv_1",
        limit: 201,
      }),
    ).toThrow();
  });

  it("rejects a non-integer limit", () => {
    expect(() =>
      conversationFilesList.input.parse({
        conversationId: "cnv_1",
        limit: 1.5,
      }),
    ).toThrow();
  });

  // ── kind filter ───────────────────────────────────────────────────────────

  it("accepts each valid kind", () => {
    const kinds = [
      "image",
      "video",
      "document",
      "spreadsheet",
      "presentation",
      "pdf",
      "archive",
    ] as const;
    for (const kind of kinds) {
      const parsed = conversationFilesList.input.parse({
        conversationId: "cnv_1",
        kind,
      });
      expect(parsed.kind).toBe(kind);
    }
  });

  it("rejects an unknown kind value", () => {
    expect(() =>
      conversationFilesList.input.parse({
        conversationId: "cnv_1",
        kind: "binary",
      }),
    ).toThrow();
  });

  it("omits kind when not provided (undefined)", () => {
    const parsed = conversationFilesList.input.parse({
      conversationId: "cnv_1",
    });
    expect(parsed.kind).toBeUndefined();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output with files and null nextCursor", () => {
    const parsed = conversationFilesList.output.parse({
      files: [
        {
          publicId: "gen_abc",
          kind: "image",
          name: "Sunset over the ocean",
          mimeType: "image/webp",
          sizeBytes: 204800,
          status: "ready",
          accessPolicy: "org",
          createdAt: "2024-06-01T12:00:00.000Z",
          url: "/api/v1/assets/gen_abc",
        },
      ],
      nextCursor: null,
    });
    expect(parsed.files).toHaveLength(1);
    expect(parsed.nextCursor).toBeNull();
  });

  it("parses output with a non-null nextCursor", () => {
    const parsed = conversationFilesList.output.parse({
      files: [],
      nextCursor: "2024-06-01T12:00:00.000Z",
    });
    expect(parsed.nextCursor).toBe("2024-06-01T12:00:00.000Z");
  });

  it("allows null sizeBytes in a file item", () => {
    const parsed = conversationFilesList.output.parse({
      files: [
        {
          publicId: "gen_xyz",
          kind: "video",
          name: "Animated explainer",
          mimeType: "video/mp4",
          sizeBytes: null,
          status: "ready",
          accessPolicy: "user",
          createdAt: "2024-06-01T12:00:00.000Z",
          url: "/api/v1/assets/gen_xyz",
        },
      ],
      nextCursor: null,
    });
    expect(parsed.files[0]?.sizeBytes).toBeNull();
  });

  it("rejects an invalid accessPolicy in a file item", () => {
    expect(() =>
      conversationAssetItem.parse({
        publicId: "gen_1",
        kind: "image",
        name: "test",
        mimeType: "image/png",
        sizeBytes: null,
        status: "ready",
        accessPolicy: "private",
        createdAt: "2024-06-01T12:00:00.000Z",
        url: "/api/v1/assets/gen_1",
      }),
    ).toThrow();
  });

  // ── conversationAssetKind enum ────────────────────────────────────────────

  it("conversationAssetKind rejects unknown values", () => {
    expect(() => conversationAssetKind.parse("binary")).toThrow();
  });

  it("conversationAssetKind accepts all seven valid kinds", () => {
    for (const kind of [
      "image",
      "video",
      "document",
      "spreadsheet",
      "presentation",
      "pdf",
      "archive",
    ]) {
      expect(() => conversationAssetKind.parse(kind)).not.toThrow();
    }
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("list_conversation_files")).toBe(
      conversationFilesList,
    );
  });

  it("has noBillingGate=true", () => {
    expect(conversationFilesList.noBillingGate).toBe(true);
  });

  it("is scoped", () => {
    expect(conversationFilesList.scoped).toBe(true);
  });

  it("includes api, mcp, and agent in surfaces", () => {
    expect(conversationFilesList.surfaces).toContain("api");
    expect(conversationFilesList.surfaces).toContain("mcp");
    expect(conversationFilesList.surfaces).toContain("agent");
  });
});
