import { describe, expect, it } from "vitest";
import { conversationRename } from "./conversation.rename";
import { getCapability } from "../registry";

describe("conversation.rename capability", () => {
  // ── input validation ──────────────────────────────────────────────────────

  it("parses a valid rename input", () => {
    const parsed = conversationRename.input.parse({
      conversationId: "cnv_abc",
      title: "My Renamed Conversation",
    });
    expect(parsed.conversationId).toBe("cnv_abc");
    expect(parsed.title).toBe("My Renamed Conversation");
  });

  it("trims whitespace from title", () => {
    const parsed = conversationRename.input.parse({
      conversationId: "cnv_abc",
      title: "  Trimmed  ",
    });
    expect(parsed.title).toBe("Trimmed");
  });

  it("rejects empty conversationId", () => {
    expect(() =>
      conversationRename.input.parse({ conversationId: "", title: "Hello" }),
    ).toThrow();
  });

  it("rejects empty title (after trim)", () => {
    expect(() =>
      conversationRename.input.parse({
        conversationId: "cnv_abc",
        title: "   ",
      }),
    ).toThrow();
  });

  it("rejects title longer than 200 characters", () => {
    expect(() =>
      conversationRename.input.parse({
        conversationId: "cnv_abc",
        title: "a".repeat(201),
      }),
    ).toThrow();
  });

  it("accepts a title of exactly 200 characters", () => {
    const parsed = conversationRename.input.parse({
      conversationId: "cnv_abc",
      title: "a".repeat(200),
    });
    expect(parsed.title).toHaveLength(200);
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output", () => {
    const parsed = conversationRename.output.parse({
      publicId: "cnv_abc",
      title: "My Renamed Conversation",
    });
    expect(parsed.publicId).toBe("cnv_abc");
    expect(parsed.title).toBe("My Renamed Conversation");
  });

  it("rejects output missing publicId", () => {
    expect(() => conversationRename.output.parse({ title: "Hello" })).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("rename_conversation")).toBe(conversationRename);
  });
});
