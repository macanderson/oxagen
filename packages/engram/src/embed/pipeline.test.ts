/**
 * Tests for embed/pipeline.ts — extractEmbeddingText and embedRecord.
 */
import { describe, it, expect, vi } from "vitest";
import { extractEmbeddingText, embedRecord } from "./pipeline";

describe("extractEmbeddingText", () => {
  it("extracts episodic text as 'event: payload'", () => {
    const text = extractEmbeddingText("episodic", {
      event: "tool_call",
      payload: "grep auth.ts",
    });
    expect(text).toBe("tool_call: grep auth.ts");
  });

  it("stringifies episodic payload when not a string", () => {
    const text = extractEmbeddingText("episodic", {
      event: "observation",
      payload: { key: "value" },
    });
    expect(text).toContain("observation:");
    expect(text).toContain("value");
  });

  it("uses empty event when episodic event is missing", () => {
    const text = extractEmbeddingText("episodic", { payload: "data" });
    expect(text).toContain(": ");
  });

  it("extracts semantic fact", () => {
    const text = extractEmbeddingText("semantic", { fact: "The API uses JWT", domain: "auth" });
    expect(text).toBe("The API uses JWT");
  });

  it("falls back to JSON for semantic without fact", () => {
    const text = extractEmbeddingText("semantic", { domain: "auth" });
    expect(text).toContain("auth");
  });

  it("extracts procedural rule", () => {
    const text = extractEmbeddingText("procedural", {
      rule: "Validate all inputs",
      appliesTo: ["api"],
      successCount: 5,
      failureCount: 0,
    });
    expect(text).toBe("Validate all inputs");
  });

  it("falls back to JSON for procedural without rule", () => {
    const text = extractEmbeddingText("procedural", { appliesTo: ["api"], successCount: 5, failureCount: 0 });
    expect(text).toContain("appliesTo");
  });

  it("extracts entity as 'type name'", () => {
    const text = extractEmbeddingText("entity", {
      entityType: "service",
      name: "auth-service",
      properties: {},
    });
    expect(text).toBe("service auth-service");
  });

  it("handles entity with missing name", () => {
    const text = extractEmbeddingText("entity", { entityType: "file", properties: {} });
    expect(text).toBe("file");
  });

  it("handles entity with missing entityType", () => {
    const text = extractEmbeddingText("entity", { name: "something", properties: {} });
    expect(text).toBe("something");
  });

  it("falls back to JSON when entity has neither type nor name", () => {
    const text = extractEmbeddingText("entity", { properties: { extra: 1 } });
    expect(text).toContain("extra");
  });

  it("extracts edge as 'type: source → target'", () => {
    const text = extractEmbeddingText("edge", {
      edgeType: "DEPENDS_ON",
      sourceId: "file-a",
      targetId: "file-b",
    });
    expect(text).toBe("DEPENDS_ON: file-a → file-b");
  });

  it("defaults edge fields to empty string when missing", () => {
    const text = extractEmbeddingText("edge", {});
    expect(text).toBe(":  → ");
  });

  it("falls back to JSON for unknown kind", () => {
    const text = extractEmbeddingText("unknown", { foo: "bar" });
    expect(text).toContain("bar");
  });

  it("truncates long text to 2000 chars for episodic", () => {
    const longPayload = "x".repeat(3000);
    const text = extractEmbeddingText("episodic", { event: "big", payload: longPayload });
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  it("truncates long JSON body for unknown kind", () => {
    const body = { data: "y".repeat(3000) };
    const text = extractEmbeddingText("weird-kind", body);
    expect(text.length).toBeLessThanOrEqual(2000);
  });
});

describe("embedRecord", () => {
  it("calls embedTextFn with extracted text and returns result", async () => {
    const mockEmbedding = [0.1, 0.2, 0.3];
    const embedTextFn = vi.fn(async (_text: string): Promise<number[]> => mockEmbedding);

    const result = await embedRecord("rec-abc", "semantic", { fact: "test fact", domain: "test" }, embedTextFn);

    expect(embedTextFn).toHaveBeenCalledOnce();
    expect(embedTextFn).toHaveBeenCalledWith("test fact");
    expect(result.recordId).toBe("rec-abc");
    expect(result.embedding).toEqual(mockEmbedding);
    expect(result.quantized).toBeInstanceOf(Int8Array);
    expect(result.quantized.length).toBe(3);
  });

  it("produces non-empty quantized array for a real embedding", async () => {
    const embedding = Array.from({ length: 1536 }, (_, i) => Math.sin(i * 0.01));
    const embedTextFn = vi.fn(async (_text: string): Promise<number[]> => embedding);

    const result = await embedRecord("rec-xyz", "episodic", { event: "test", payload: {} }, embedTextFn);

    expect(result.quantized.length).toBe(1536);
  });

  it("passes the correct text for each record kind", async () => {
    const capturedTexts: string[] = [];
    const embedTextFn = vi.fn(async (text: string): Promise<number[]> => {
      capturedTexts.push(text);
      return [0.5];
    });

    await embedRecord("r1", "procedural", { rule: "Always validate", appliesTo: [], successCount: 0, failureCount: 0 }, embedTextFn);
    expect(capturedTexts[0]).toBe("Always validate");
  });
});
