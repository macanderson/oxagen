import { describe, expect, it } from "vitest";
import {
  isCurrentUserTurnAtHead,
  CHAT_MAX_RETRIES,
  CHAT_MAX_OVERFLOW_RETRIES,
} from "./history-dedup";

describe("isCurrentUserTurnAtHead", () => {
  it("is true when the newest row is the user turn matching parentMessageId", () => {
    const rows = [
      { id: "u2", role: "user" },
      { id: "a1", role: "assistant" },
    ];
    expect(isCurrentUserTurnAtHead(rows, "u2")).toBe(true);
  });

  it("is false when parentMessageId is null (nothing to dedup)", () => {
    const rows = [{ id: "u2", role: "user" }];
    expect(isCurrentUserTurnAtHead(rows, null)).toBe(false);
  });

  it("is false when the newest row id does not match (turn not yet persisted)", () => {
    const rows = [
      { id: "a1", role: "assistant" },
      { id: "u1", role: "user" },
    ];
    expect(isCurrentUserTurnAtHead(rows, "u2")).toBe(false);
  });

  it("is false when the newest row is not a user message", () => {
    const rows = [{ id: "u2", role: "assistant" }];
    expect(isCurrentUserTurnAtHead(rows, "u2")).toBe(false);
  });

  it("dedups by id even when a prior turn has identical text (the old bug)", () => {
    // Two user turns with the SAME text; only the id disambiguates which is the
    // current turn — a text comparison would have matched the wrong (or a stale)
    // row. rows[0] is the newest.
    const rows = [
      { id: "u2", role: "user" }, // current turn (same text as u1)
      { id: "a1", role: "assistant" },
      { id: "u1", role: "user" },
    ];
    expect(isCurrentUserTurnAtHead(rows, "u2")).toBe(true);
    expect(isCurrentUserTurnAtHead(rows, "u1")).toBe(false);
  });

  it("is false for empty history", () => {
    expect(isCurrentUserTurnAtHead([], "u2")).toBe(false);
  });
});

describe("chat engine resilience constants", () => {
  it("allows at least one transient retry and one overflow-compaction retry", () => {
    // Regression guard for the audited 0/0 defect: a single 429/5xx must not
    // kill the turn, and context overflow must trigger compact-and-retry.
    expect(CHAT_MAX_RETRIES).toBeGreaterThanOrEqual(1);
    expect(CHAT_MAX_OVERFLOW_RETRIES).toBeGreaterThanOrEqual(1);
  });
});
