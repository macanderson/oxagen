import { describe, expect, it } from "vitest";
import { documentCreate } from "./document.create";
import { getCapability } from "../registry";

describe("document.create capability", () => {
  // ── input: required fields ────────────────────────────────────────────────

  it("accepts a minimal valid input with title only", () => {
    const parsed = documentCreate.input.parse({ title: "My Doc" });
    expect(parsed.title).toBe("My Doc");
    expect(parsed.content).toBeUndefined();
  });

  it("accepts input with both title and content", () => {
    const parsed = documentCreate.input.parse({
      title: "My Doc",
      content: "Some body text",
    });
    expect(parsed.title).toBe("My Doc");
    expect(parsed.content).toBe("Some body text");
  });

  it("rejects missing title", () => {
    expect(() => documentCreate.input.parse({})).toThrow();
  });

  it("rejects an empty title (min 1)", () => {
    expect(() => documentCreate.input.parse({ title: "" })).toThrow();
  });

  it("accepts title of exactly 1 character (min boundary)", () => {
    const parsed = documentCreate.input.parse({ title: "X" });
    expect(parsed.title).toBe("X");
  });

  it("rejects wrong type for title", () => {
    expect(() => documentCreate.input.parse({ title: 42 })).toThrow();
  });

  it("rejects wrong type for content", () => {
    expect(() =>
      documentCreate.input.parse({ title: "My Doc", content: 123 }),
    ).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output with all required fields", () => {
    const parsed = documentCreate.output.parse({
      document_id: "doc_abc123",
      title: "My Doc",
      created_at: "2024-01-01T00:00:00.000Z",
      workspace_id: "ws_xyz789",
    });
    expect(parsed.document_id).toBe("doc_abc123");
    expect(parsed.title).toBe("My Doc");
    expect(parsed.created_at).toBe("2024-01-01T00:00:00.000Z");
    expect(parsed.workspace_id).toBe("ws_xyz789");
  });

  it("rejects output missing document_id", () => {
    expect(() =>
      documentCreate.output.parse({
        title: "My Doc",
        created_at: "2024-01-01T00:00:00.000Z",
        workspace_id: "ws_xyz789",
      }),
    ).toThrow();
  });

  it("rejects output missing workspace_id", () => {
    expect(() =>
      documentCreate.output.parse({
        document_id: "doc_abc123",
        title: "My Doc",
        created_at: "2024-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects output with wrong type for document_id", () => {
    expect(() =>
      documentCreate.output.parse({
        document_id: 999,
        title: "My Doc",
        created_at: "2024-01-01T00:00:00.000Z",
        workspace_id: "ws_xyz789",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("create_document")).toBe(documentCreate);
  });
});
