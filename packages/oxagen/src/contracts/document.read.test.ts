import { describe, expect, it } from "vitest";
import { documentRead } from "./document.read";
import { getCapability } from "../registry";

describe("document.read capability", () => {
  // ── input: required document_id ───────────────────────────────────────────

  it("accepts a valid document_id string", () => {
    const parsed = documentRead.input.parse({ document_id: "doc_abc123" });
    expect(parsed.document_id).toBe("doc_abc123");
  });

  it("rejects missing document_id", () => {
    expect(() => documentRead.input.parse({})).toThrow();
  });

  it("rejects wrong type for document_id", () => {
    expect(() => documentRead.input.parse({ document_id: 42 })).toThrow();
  });

  it("rejects null document_id", () => {
    expect(() => documentRead.input.parse({ document_id: null })).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output with all required fields and empty metadata", () => {
    const parsed = documentRead.output.parse({
      title: "My Document",
      content: "Body of the document.",
      metadata: {},
      created_at: "2024-01-01T00:00:00.000Z",
    });
    expect(parsed.title).toBe("My Document");
    expect(parsed.content).toBe("Body of the document.");
    expect(parsed.metadata).toEqual({});
    expect(parsed.created_at).toBe("2024-01-01T00:00:00.000Z");
  });

  it("parses output with populated metadata record", () => {
    const parsed = documentRead.output.parse({
      title: "Doc",
      content: "Content",
      metadata: { version: 2, tags: ["alpha", "beta"], draft: false },
      created_at: "2024-03-15T12:00:00.000Z",
    });
    expect(parsed.metadata["version"]).toBe(2);
    expect(parsed.metadata["tags"]).toEqual(["alpha", "beta"]);
    expect(parsed.metadata["draft"]).toBe(false);
  });

  it("rejects output missing the content field", () => {
    expect(() =>
      documentRead.output.parse({
        title: "Doc",
        metadata: {},
        created_at: "2024-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects output missing the metadata field", () => {
    expect(() =>
      documentRead.output.parse({
        title: "Doc",
        content: "Content",
        created_at: "2024-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects output with wrong type for metadata (array instead of record)", () => {
    expect(() =>
      documentRead.output.parse({
        title: "Doc",
        content: "Content",
        metadata: ["not", "a", "record"],
        created_at: "2024-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects output with wrong type for title", () => {
    expect(() =>
      documentRead.output.parse({
        title: 99,
        content: "Content",
        metadata: {},
        created_at: "2024-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("read_document")).toBe(documentRead);
  });
});
