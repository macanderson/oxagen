import { describe, expect, it } from "vitest";
import { initials } from "./format";
import { isCommandShortcut } from "./shell-state";

describe("initials", () => {
  it("takes the first and last word", () => {
    expect(initials("Marcus Bell")).toBe("MB");
    expect(initials("  priya   q natarajan ")).toBe("PN");
    expect(initials("Dana")).toBe("D");
    expect(initials("")).toBe("");
  });
});

describe("shell state helpers", () => {
  it("recognises ⌘K and Ctrl+K only", () => {
    const key = (over: Partial<KeyboardEvent>) => ({
      key: "k",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...over,
    });
    expect(isCommandShortcut(key({ metaKey: true }))).toBe(true);
    expect(isCommandShortcut(key({ ctrlKey: true, key: "K" }))).toBe(true);
    expect(isCommandShortcut(key({}))).toBe(false);
    expect(isCommandShortcut(key({ metaKey: true, shiftKey: true }))).toBe(
      false,
    );
    expect(isCommandShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isCommandShortcut(key({ metaKey: true, key: "j" }))).toBe(false);
  });
});
