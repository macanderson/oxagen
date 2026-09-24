// The flyout width the cookie remembers: read back, written, and held between
// the designed width and what the viewport leaves room for.
import { describe, expect, it } from "vitest";
import {
  ASSISTANT_MIN_WIDTH,
  ASSISTANT_WIDTH_STEP,
  assistantWidthCookieString,
  clampAssistantWidth,
  readAssistantWidth,
  widestAssistant,
  widthForKey,
} from "./assistant-width";

describe("readAssistantWidth", () => {
  it("reads the remembered width among other cookies", () => {
    expect(readAssistantWidth("assistant_width=612")).toBe(612);
    expect(
      readAssistantWidth("theme=dark; assistant_width=700; sidebar_state=true"),
    ).toBe(700);
  });

  it("opens at the designed width when nothing usable is remembered (negative)", () => {
    expect(readAssistantWidth("")).toBe(ASSISTANT_MIN_WIDTH);
    expect(readAssistantWidth("theme=dark")).toBe(ASSISTANT_MIN_WIDTH);
    expect(readAssistantWidth("assistant_width=wide")).toBe(
      ASSISTANT_MIN_WIDTH,
    );
    expect(readAssistantWidth("assistant_width=612.5")).toBe(
      ASSISTANT_MIN_WIDTH,
    );
    // A name that only ends in the cookie's name is a different cookie.
    expect(readAssistantWidth("old_assistant_width=900")).toBe(
      ASSISTANT_MIN_WIDTH,
    );
  });

  it("never reads narrower than the designed width (negative)", () => {
    expect(readAssistantWidth("assistant_width=200")).toBe(ASSISTANT_MIN_WIDTH);
    expect(readAssistantWidth("assistant_width=0")).toBe(ASSISTANT_MIN_WIDTH);
  });
});

describe("assistantWidthCookieString", () => {
  it("remembers a whole-pixel width for a year across the site", () => {
    expect(assistantWidthCookieString(612.4, false)).toBe(
      "assistant_width=612; Path=/; Max-Age=31536000; SameSite=Lax",
    );
  });

  it("marks the cookie Secure over https", () => {
    expect(assistantWidthCookieString(700, true)).toBe(
      "assistant_width=700; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
    );
  });

  it("round-trips through readAssistantWidth", () => {
    const written = assistantWidthCookieString(815, false).split(";")[0];
    expect(readAssistantWidth(written ?? "")).toBe(815);
  });
});

describe("widestAssistant", () => {
  it("leaves the 56px strip of page in view", () => {
    // Sidebar 240px, viewport 1440px: 1440 - 240 - 56.
    expect(widestAssistant(240, 1440)).toBe(1144);
    expect(widestAssistant(240.6, 1440)).toBe(1143);
  });

  it("never falls below the designed width on a narrow window (negative)", () => {
    expect(widestAssistant(240, 600)).toBe(ASSISTANT_MIN_WIDTH);
  });
});

describe("clampAssistantWidth", () => {
  it("holds a width between the designed width and the widest", () => {
    expect(clampAssistantWidth(600, 900)).toBe(600);
    expect(clampAssistantWidth(1200, 900)).toBe(900);
    expect(clampAssistantWidth(600.6, 900)).toBe(601);
  });

  it("refuses to go narrower than the designed width (negative)", () => {
    expect(clampAssistantWidth(100, 900)).toBe(ASSISTANT_MIN_WIDTH);
    expect(clampAssistantWidth(-40, 900)).toBe(ASSISTANT_MIN_WIDTH);
    // A widest below the minimum still yields the minimum, not less.
    expect(clampAssistantWidth(500, 300)).toBe(ASSISTANT_MIN_WIDTH);
  });
});

describe("widthForKey", () => {
  it("steps with the arrows, and jumps with Home and End", () => {
    expect(widthForKey("ArrowRight", 500, 900)).toBe(
      500 + ASSISTANT_WIDTH_STEP,
    );
    expect(widthForKey("ArrowLeft", 500, 900)).toBe(500 - ASSISTANT_WIDTH_STEP);
    expect(widthForKey("Home", 700, 900)).toBe(ASSISTANT_MIN_WIDTH);
    expect(widthForKey("End", 500, 900)).toBe(900);
  });

  it("stops at both ends (negative)", () => {
    expect(widthForKey("ArrowLeft", ASSISTANT_MIN_WIDTH, 900)).toBe(
      ASSISTANT_MIN_WIDTH,
    );
    expect(widthForKey("ArrowRight", 900, 900)).toBe(900);
  });

  it("ignores keys the handle does not use (negative)", () => {
    expect(widthForKey("Enter", 500, 900)).toBeNull();
    expect(widthForKey("ArrowUp", 500, 900)).toBeNull();
  });
});
