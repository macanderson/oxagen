import { describe, it, expect } from "vitest";
import {
  resolveEscapeAction,
  DOUBLE_ESC_WINDOW_MS,
  type EscapeState,
} from "./escape-action";

// Convenience builders.
const idle = (overrides: Partial<EscapeState> = {}): EscapeState => ({
  isStreaming: false,
  resetPending: false,
  lastEscapeMs: null,
  ...overrides,
});

const streaming = (overrides: Partial<EscapeState> = {}): EscapeState => ({
  isStreaming: true,
  resetPending: false,
  lastEscapeMs: null,
  ...overrides,
});

const BASE_NOW = 10_000;

describe("resolveEscapeAction", () => {
  // ── Single Esc while streaming ──────────────────────────────────────────────

  it("returns 'stop' when the agent is streaming (no prior Esc)", () => {
    expect(resolveEscapeAction(streaming(), BASE_NOW)).toBe("stop");
  });

  it("returns 'stop' when the agent is streaming even with a very recent prior Esc", () => {
    expect(
      resolveEscapeAction(
        streaming({ lastEscapeMs: BASE_NOW - 100 }),
        BASE_NOW,
      ),
    ).toBe("stop");
  });

  // ── Single idle Esc (no prior Esc) — no-op ─────────────────────────────────

  it("returns 'none' for the first idle Esc with no prior timestamp", () => {
    expect(resolveEscapeAction(idle(), BASE_NOW)).toBe("none");
  });

  // ── Second idle Esc within the double-Esc window ───────────────────────────

  it("returns 'prompt-reset' when a second idle Esc arrives within the window", () => {
    const lastEsc = BASE_NOW - Math.floor(DOUBLE_ESC_WINDOW_MS / 2); // well inside
    expect(resolveEscapeAction(idle({ lastEscapeMs: lastEsc }), BASE_NOW)).toBe(
      "prompt-reset",
    );
  });

  it("returns 'prompt-reset' when the second Esc arrives exactly at the window boundary", () => {
    const lastEsc = BASE_NOW - DOUBLE_ESC_WINDOW_MS; // exactly on the boundary
    expect(resolveEscapeAction(idle({ lastEscapeMs: lastEsc }), BASE_NOW)).toBe(
      "prompt-reset",
    );
  });

  // ── Second idle Esc outside the window — treated as a new first Esc ────────

  it("returns 'none' when the second Esc arrives after the window has elapsed", () => {
    const lastEsc = BASE_NOW - (DOUBLE_ESC_WINDOW_MS + 1);
    expect(resolveEscapeAction(idle({ lastEscapeMs: lastEsc }), BASE_NOW)).toBe(
      "none",
    );
  });

  // ── Esc while resetPending is true — always 'none' ─────────────────────────

  it("returns 'none' when a reset confirmation is already pending (not streaming)", () => {
    expect(
      resolveEscapeAction(
        idle({ resetPending: true, lastEscapeMs: 0 }),
        BASE_NOW,
      ),
    ).toBe("none");
  });

  it("returns 'none' when a reset confirmation is already pending (streaming)", () => {
    // The UI handler deals with this case before calling the helper, but the
    // helper must still be safe to call in this state.
    expect(
      resolveEscapeAction(
        streaming({ resetPending: true, lastEscapeMs: 0 }),
        BASE_NOW,
      ),
    ).toBe("none");
  });

  // ── Stop → then second Esc within window → prompt-reset ───────────────────
  // Simulates: Esc #1 while streaming → 'stop' (caller records lastEscapeMs=t1);
  // then Esc #2 while idle (streaming done), within window → 'prompt-reset'.

  it("returns 'prompt-reset' for the Esc that follows a 'stop' within the window", () => {
    const t1 = BASE_NOW;
    const t2 = t1 + 800; // 800 ms later — well within DOUBLE_ESC_WINDOW_MS
    // State after the 'stop': streaming has ended, lastEscapeMs = t1.
    expect(resolveEscapeAction(idle({ lastEscapeMs: t1 }), t2)).toBe(
      "prompt-reset",
    );
  });

  it("returns 'none' if too much time passes between stop and the next Esc", () => {
    const t1 = BASE_NOW;
    const t2 = t1 + DOUBLE_ESC_WINDOW_MS + 500; // past the window
    expect(resolveEscapeAction(idle({ lastEscapeMs: t1 }), t2)).toBe("none");
  });

  // ── Confirmation response logic (handled in the caller, not here, but
  //    document the expected confirm/cancel strings for reference) ─────────────

  describe("confirmation string acceptance (caller responsibility, documented here)", () => {
    const ACCEPTED = ["y", "yes", "Y", "YES", "Yes"];
    const REJECTED = ["n", "no", "cancel", "", " ", "yep", "sure"];

    it("only 'y' and 'yes' (case-insensitive, trimmed) should confirm — all others cancel", () => {
      // This is a spec check, not runtime logic — callers use:
      //   const answer = text.trim().toLowerCase();
      //   const confirmed = answer === "y" || answer === "yes";
      for (const input of ACCEPTED) {
        const answer = input.trim().toLowerCase();
        expect(answer === "y" || answer === "yes").toBe(true);
      }
      for (const input of REJECTED) {
        const answer = input.trim().toLowerCase();
        expect(answer === "y" || answer === "yes").toBe(false);
      }
    });
  });
});
