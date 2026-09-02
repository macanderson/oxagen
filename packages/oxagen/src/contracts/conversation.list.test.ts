import { describe, expect, it } from "vitest";
import { conversationList } from "./conversation.list";
import { getCapability } from "../registry";

describe("conversation.list capability", () => {
  // ── input defaults ────────────────────────────────────────────────────────

  it("defaults filter to 'active'", () => {
    const parsed = conversationList.input.parse({ limit: 10, cursor: null });
    expect(parsed.filter).toBe("active");
  });

  it("defaults limit to 50", () => {
    const parsed = conversationList.input.parse({});
    expect(parsed.limit).toBe(50);
  });

  it("defaults cursor to null", () => {
    const parsed = conversationList.input.parse({});
    expect(parsed.cursor).toBeNull();
  });

  // ── filter enum ───────────────────────────────────────────────────────────

  it("parses filter='archived'", () => {
    const parsed = conversationList.input.parse({ filter: "archived" });
    expect(parsed.filter).toBe("archived");
  });

  it("rejects an unknown filter value", () => {
    expect(() => conversationList.input.parse({ filter: "deleted" })).toThrow();
  });

  // ── limit bounds ──────────────────────────────────────────────────────────

  it("accepts limit=1 (min)", () => {
    const parsed = conversationList.input.parse({ limit: 1 });
    expect(parsed.limit).toBe(1);
  });

  it("accepts limit=100 (max)", () => {
    const parsed = conversationList.input.parse({ limit: 100 });
    expect(parsed.limit).toBe(100);
  });

  it("rejects limit=0 (below min)", () => {
    expect(() => conversationList.input.parse({ limit: 0 })).toThrow();
  });

  it("rejects limit=101 (above max)", () => {
    expect(() => conversationList.input.parse({ limit: 101 })).toThrow();
  });

  it("rejects a non-integer limit", () => {
    expect(() => conversationList.input.parse({ limit: 1.5 })).toThrow();
  });

  // ── cursor ────────────────────────────────────────────────────────────────

  it("accepts a cursor ISO string", () => {
    const parsed = conversationList.input.parse({
      cursor: "2024-01-01T00:00:00.000Z",
    });
    expect(parsed.cursor).toBe("2024-01-01T00:00:00.000Z");
  });

  it("accepts a null cursor", () => {
    const parsed = conversationList.input.parse({ cursor: null });
    expect(parsed.cursor).toBeNull();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output with conversations and null nextCursor", () => {
    const parsed = conversationList.output.parse({
      conversations: [
        {
          publicId: "cnv_1",
          title: "Hello",
          status: "active",
          archivedAt: null,
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-02T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    expect(parsed.conversations).toHaveLength(1);
    expect(parsed.nextCursor).toBeNull();
  });

  it("parses output with a non-null nextCursor", () => {
    const parsed = conversationList.output.parse({
      conversations: [],
      nextCursor: "2024-01-01T00:00:00.000Z",
    });
    expect(parsed.nextCursor).toBe("2024-01-01T00:00:00.000Z");
  });

  it("parses a conversation summary with null title", () => {
    const parsed = conversationList.output.parse({
      conversations: [
        {
          publicId: "cnv_1",
          title: null,
          status: "active",
          archivedAt: null,
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    expect(parsed.conversations[0]?.title).toBeNull();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("list_conversations")).toBe(conversationList);
  });
});
