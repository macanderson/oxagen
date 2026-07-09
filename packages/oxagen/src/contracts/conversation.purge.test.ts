import { describe, expect, it } from "vitest";
import { conversationPurge } from "./conversation.purge";
import { getCapability } from "../registry";

describe("conversation.purge capability", () => {
  // ── input shape ───────────────────────────────────────────────────────────

  it("parses an empty input object", () => {
    const parsed = conversationPurge.input.parse({});
    expect(parsed).toEqual({});
  });

  it("ignores unknown fields on input (strict zod strips them)", () => {
    // z.object({}) strips unknown keys — parse should not throw
    const parsed = conversationPurge.input.parse({ unexpected: "field" });
    expect(parsed).toEqual({});
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output with deleted count", () => {
    const parsed = conversationPurge.output.parse({ deleted: 5 });
    expect(parsed.deleted).toBe(5);
  });

  it("accepts deleted=0 (no archived conversations to purge)", () => {
    const parsed = conversationPurge.output.parse({ deleted: 0 });
    expect(parsed.deleted).toBe(0);
  });

  it("rejects negative deleted", () => {
    expect(() => conversationPurge.output.parse({ deleted: -1 })).toThrow();
  });

  it("rejects a non-integer deleted", () => {
    expect(() => conversationPurge.output.parse({ deleted: 1.5 })).toThrow();
  });

  it("rejects missing deleted field", () => {
    expect(() => conversationPurge.output.parse({})).toThrow();
  });

  // ── metadata ──────────────────────────────────────────────────────────────

  it("has riskLevel='high' (destructive operation)", () => {
    expect(conversationPurge.agent.riskLevel).toBe("high");
  });

  it("requires approval (destructive operation)", () => {
    expect(conversationPurge.agent.requiresApproval).toBe(true);
  });

  it("has sensitivity='destructive'", () => {
    expect(conversationPurge.sensitivity).toBe("destructive");
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("purge_conversations")).toBe(conversationPurge);
  });
});
