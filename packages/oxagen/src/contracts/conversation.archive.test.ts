import { describe, expect, it } from "vitest";
import { conversationArchive } from "./conversation.archive";
import { getCapability } from "../registry";

describe("conversation.archive capability", () => {
  // ── input validation ──────────────────────────────────────────────────────

  it("parses a valid archive input with archived=true", () => {
    const parsed = conversationArchive.input.parse({
      conversationIds: ["cnv_1", "cnv_2"],
      archived: true,
    });
    expect(parsed.conversationIds).toEqual(["cnv_1", "cnv_2"]);
    expect(parsed.archived).toBe(true);
  });

  it("parses a valid unarchive input with archived=false", () => {
    const parsed = conversationArchive.input.parse({
      conversationIds: ["cnv_1"],
      archived: false,
    });
    expect(parsed.archived).toBe(false);
  });

  // ── conversationIds bounds ─────────────────────────────────────────────────

  it("accepts conversationIds with 1 item (min)", () => {
    const parsed = conversationArchive.input.parse({
      conversationIds: ["cnv_1"],
      archived: true,
    });
    expect(parsed.conversationIds).toHaveLength(1);
  });

  it("accepts conversationIds with 100 items (max)", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `cnv_${i}`);
    const parsed = conversationArchive.input.parse({
      conversationIds: ids,
      archived: true,
    });
    expect(parsed.conversationIds).toHaveLength(100);
  });

  it("rejects empty conversationIds array (min=1)", () => {
    expect(() =>
      conversationArchive.input.parse({ conversationIds: [], archived: true }),
    ).toThrow();
  });

  it("rejects conversationIds with 101 items (above max)", () => {
    const ids = Array.from({ length: 101 }, (_, i) => `cnv_${i}`);
    expect(() =>
      conversationArchive.input.parse({ conversationIds: ids, archived: true }),
    ).toThrow();
  });

  it("rejects a conversationId that is an empty string", () => {
    expect(() =>
      conversationArchive.input.parse({
        conversationIds: [""],
        archived: true,
      }),
    ).toThrow();
  });

  it("rejects missing archived field", () => {
    expect(() =>
      conversationArchive.input.parse({ conversationIds: ["cnv_1"] }),
    ).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output", () => {
    const parsed = conversationArchive.output.parse({ updated: 3 });
    expect(parsed.updated).toBe(3);
  });

  it("accepts updated=0", () => {
    const parsed = conversationArchive.output.parse({ updated: 0 });
    expect(parsed.updated).toBe(0);
  });

  it("rejects negative updated", () => {
    expect(() => conversationArchive.output.parse({ updated: -1 })).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("archive_conversation")).toBe(conversationArchive);
  });
});
