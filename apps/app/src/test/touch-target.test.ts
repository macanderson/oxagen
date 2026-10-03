import { describe, expect, it } from "vitest";
import { expectTouchTarget, lengthPx } from "./touch-target";

describe("touch target", () => {
  it("reads a px length and a spacing step at the kit's 4px unit", () => {
    expect(lengthPx("44px")).toBe(44);
    expect(lengthPx("calc(var(--spacing) * 11)")).toBe(44);
    expect(lengthPx("calc(var(--spacing)*12.5)")).toBe(50);
  });

  it("reads nothing it cannot resolve", () => {
    expect(lengthPx("var(--touch)")).toBeNaN();
    expect(lengthPx("")).toBeNaN();
  });

  it("passes a 44px floor and fails one under it", () => {
    expectTouchTarget("calc(var(--spacing) * 11)");
    expectTouchTarget("48px");
    expect(() => {
      expectTouchTarget("calc(var(--spacing) * 10)");
    }).toThrow();
    expect(() => {
      expectTouchTarget("auto");
    }).toThrow();
  });
});
