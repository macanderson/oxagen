// utils.test.ts — unit tests for the cn() utility.
//
// cn() wraps clsx (conditional class joining) with tailwind-merge (conflict
// resolution). Tests confirm the full composition, not just either library
// in isolation.

import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("returns an empty string for no arguments", () => {
    expect(cn()).toBe("");
  });

  it("returns an empty string for falsy-only arguments", () => {
    expect(cn(undefined, null, false, "")).toBe("");
  });

  it("joins two plain class strings", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("resolves conflicting Tailwind classes — last one wins", () => {
    // tailwind-merge should keep only 'p-4', dropping 'p-2'.
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("resolves conflicting background-color classes", () => {
    expect(cn("bg-red-500", "bg-blue-500")).toBe("bg-blue-500");
  });

  it("handles conditional classes via object syntax", () => {
    expect(cn("base", { active: true, disabled: false })).toBe("base active");
  });

  it("handles conditional classes via array syntax", () => {
    expect(cn(["base", false && "hidden", "visible"])).toBe("base visible");
  });

  it("does not duplicate identical classes", () => {
    // tailwind-merge deduplicates same-utility classes.
    expect(cn("text-sm", "text-sm")).toBe("text-sm");
  });

  it("preserves non-conflicting classes from both arguments", () => {
    const result = cn("flex items-center", "gap-2 text-sm");
    expect(result).toContain("flex");
    expect(result).toContain("items-center");
    expect(result).toContain("gap-2");
    expect(result).toContain("text-sm");
  });
});
