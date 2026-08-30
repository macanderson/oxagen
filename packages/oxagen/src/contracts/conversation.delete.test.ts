import { describe, expect, it } from "vitest";
import { conversationDelete } from "./conversation.delete";
import { getCapability } from "../registry";

describe("conversation.delete capability", () => {
  // ── input validation ──────────────────────────────────────────────────────

  it("parses valid input with a single id", () => {
    const parsed = conversationDelete.input.parse({
      conversationIds: ["cnv_1"],
    });
    expect(parsed.conversationIds).toEqual(["cnv_1"]);
  });

  it("parses valid input with multiple ids", () => {
    const parsed = conversationDelete.input.parse({
      conversationIds: ["cnv_1", "cnv_2", "cnv_3"],
    });
    expect(parsed.conversationIds).toHaveLength(3);
  });

  // ── conversationIds bounds ─────────────────────────────────────────────────

  it("accepts 1 id (min)", () => {
    const parsed = conversationDelete.input.parse({
      conversationIds: ["cnv_1"],
    });
    expect(parsed.conversationIds).toHaveLength(1);
  });

  it("accepts 100 ids (max)", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `cnv_${i}`);
    const parsed = conversationDelete.input.parse({ conversationIds: ids });
    expect(parsed.conversationIds).toHaveLength(100);
  });

  it("rejects empty array (below min=1)", () => {
    expect(() =>
      conversationDelete.input.parse({ conversationIds: [] }),
    ).toThrow();
  });

  it("rejects 101 ids (above max=100)", () => {
    const ids = Array.from({ length: 101 }, (_, i) => `cnv_${i}`);
    expect(() =>
      conversationDelete.input.parse({ conversationIds: ids }),
    ).toThrow();
  });

  it("rejects an empty string id", () => {
    expect(() =>
      conversationDelete.input.parse({ conversationIds: [""] }),
    ).toThrow();
  });

  it("rejects missing conversationIds", () => {
    expect(() => conversationDelete.input.parse({})).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output", () => {
    const parsed = conversationDelete.output.parse({ deleted: 2 });
    expect(parsed.deleted).toBe(2);
  });

  it("accepts deleted=0", () => {
    const parsed = conversationDelete.output.parse({ deleted: 0 });
    expect(parsed.deleted).toBe(0);
  });

  it("rejects negative deleted", () => {
    expect(() => conversationDelete.output.parse({ deleted: -1 })).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("delete_conversation")).toBe(conversationDelete);
  });
});
