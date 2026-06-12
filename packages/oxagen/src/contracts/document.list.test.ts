import { describe, expect, it } from "vitest";
import { documentList } from "./document.list";
import { getCapability } from "../registry";

describe("document.list capability", () => {
  // ── input: optional workspace_id ──────────────────────────────────────────

  it("accepts empty input (workspace_id is optional)", () => {
    const parsed = documentList.input.parse({});
    expect(parsed.workspace_id).toBeUndefined();
  });

  it("accepts a valid workspace_id string", () => {
    const parsed = documentList.input.parse({ workspace_id: "ws_abc123" });
    expect(parsed.workspace_id).toBe("ws_abc123");
  });

  it("rejects wrong type for workspace_id", () => {
    expect(() => documentList.input.parse({ workspace_id: 42 })).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output with a non-empty documents array", () => {
    const parsed = documentList.output.parse({
      documents: [
        {
          id: "doc_001",
          title: "First Doc",
          created_at: "2024-01-01T00:00:00.000Z",
          updated_at: "2024-01-02T00:00:00.000Z",
          author: "alice@example.com",
        },
      ],
    });
    expect(parsed.documents).toHaveLength(1);
    expect(parsed.documents[0]?.id).toBe("doc_001");
    expect(parsed.documents[0]?.title).toBe("First Doc");
    expect(parsed.documents[0]?.author).toBe("alice@example.com");
  });

  it("parses a valid output with an empty documents array", () => {
    const parsed = documentList.output.parse({ documents: [] });
    expect(parsed.documents).toHaveLength(0);
  });

  it("parses multiple documents correctly", () => {
    const parsed = documentList.output.parse({
      documents: [
        {
          id: "doc_001",
          title: "Doc A",
          created_at: "2024-01-01T00:00:00.000Z",
          updated_at: "2024-01-01T00:00:00.000Z",
          author: "alice@example.com",
        },
        {
          id: "doc_002",
          title: "Doc B",
          created_at: "2024-02-01T00:00:00.000Z",
          updated_at: "2024-02-02T00:00:00.000Z",
          author: "bob@example.com",
        },
      ],
    });
    expect(parsed.documents).toHaveLength(2);
    expect(parsed.documents[1]?.id).toBe("doc_002");
  });

  it("rejects output missing the documents field", () => {
    expect(() => documentList.output.parse({})).toThrow();
  });

  it("rejects a document item missing required field 'author'", () => {
    expect(() =>
      documentList.output.parse({
        documents: [
          {
            id: "doc_001",
            title: "First Doc",
            created_at: "2024-01-01T00:00:00.000Z",
            updated_at: "2024-01-02T00:00:00.000Z",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a document item with wrong type for id", () => {
    expect(() =>
      documentList.output.parse({
        documents: [
          {
            id: 123,
            title: "First Doc",
            created_at: "2024-01-01T00:00:00.000Z",
            updated_at: "2024-01-02T00:00:00.000Z",
            author: "alice@example.com",
          },
        ],
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("document.list")).toBe(documentList);
  });
});
