// utils.test.ts — unit tests for the cn() utility.
//
// cn() wraps clsx (conditional class joining) with tailwind-merge (conflict
// resolution). Tests confirm the full composition, not just either library
// in isolation.

import { readFileSync } from "node:fs";
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

// The house type utilities, `text-a-<step>` and `text-m-<step>`, set a font
// size. tailwind-merge's default config read them as a text colour, so a
// colour class in the same list dropped them (#5185).
describe("cn with the house type utilities", () => {
  // Read every step from the stylesheet that defines the utilities, so a step
  // added there runs the cases below and fails them until TYPE_STEPS in
  // utils.ts names it too.
  const css = readFileSync(new URL("../styles/house-tailwind.css", import.meta.url), "utf8");
  const UTILITIES = [...css.matchAll(/^@utility (text-[am]-[a-z0-9]+) \{/gm)].map(
    (match) => match[1] as string,
  );
  const stepsOf = (scale: "a" | "m") =>
    UTILITIES.filter((name) => name.startsWith(`text-${scale}-`)).map((name) => name.slice(7));

  it("finds both scales in house-tailwind.css", () => {
    // Guards the cases below: a pattern that matched nothing would pass them all.
    expect(UTILITIES).toContain("text-a-h1");
    expect(UTILITIES).toContain("text-a-micro");
    expect(UTILITIES).toContain("text-m-h1");
    expect(UTILITIES).toContain("text-m-micro");
    expect(stepsOf("a")).toEqual(stepsOf("m"));
  });

  it("keeps a size and a colour given in one string", () => {
    expect(cn("text-a-h3 text-foreground")).toBe("text-a-h3 text-foreground");
  });

  it.each(UTILITIES)("keeps %s beside a later text colour", (size) => {
    expect(cn(size, "text-foreground")).toBe(`${size} text-foreground`);
  });

  it.each(UTILITIES)("keeps %s after a text colour", (size) => {
    expect(cn("text-muted-foreground", size)).toBe(`text-muted-foreground ${size}`);
  });

  it.each(UTILITIES)("keeps %s beside an arbitrary text colour", (size) => {
    expect(cn(size, "text-[var(--body)]")).toBe(`${size} text-[var(--body)]`);
  });

  it.each(UTILITIES)("keeps %s on its own", (size) => {
    expect(cn(size)).toBe(size);
  });

  it("lets a later house size override an earlier one in the same scale", () => {
    expect(cn("text-a-h3", "text-a-h1")).toBe("text-a-h1");
    expect(cn("text-m-body text-foreground", "text-m-h2")).toBe("text-foreground text-m-h2");
  });

  it("lets a later house size override one from the other scale", () => {
    expect(cn("text-m-body", "text-a-body")).toBe("text-a-body");
    expect(cn("text-a-micro", "text-m-micro")).toBe("text-m-micro");
  });

  it("treats a stock size and a house size as the same property", () => {
    expect(cn("text-sm", "text-a-h3")).toBe("text-a-h3");
    expect(cn("text-a-h3", "text-sm")).toBe("text-sm");
    expect(cn("text-a-h3", "text-[1.5rem]")).toBe("text-[1.5rem]");
  });

  it("keeps house sizes under different variants", () => {
    expect(cn("text-a-h3", "md:text-a-h1")).toBe("text-a-h3 md:text-a-h1");
  });

  it("still lets a later colour override an earlier one", () => {
    expect(cn("text-a-h3 text-muted-foreground", "text-foreground")).toBe(
      "text-a-h3 text-foreground",
    );
  });
});
