/**
 * sidebar-item.test.ts — unit tests for sidebar item affordance logic.
 *
 * Tests the exported `sidebarItemAffordance` pure function. The React
 * component itself requires DOM/JSDOM to render and is covered by e2e tests.
 *
 * Test scenarios:
 *   1. Default — neither external nor isReturn → "none"
 *   2. external: true → "external"
 *   3. isReturn: true → "return"
 *   4. Both external + isReturn — isReturn takes precedence → "return"
 *   5. Explicit false values → "none"
 */

import { describe, it, expect } from "vitest";
import { sidebarItemAffordance, type SidebarItemAffordance } from "../../lib/sidebar-item-affordance";

describe("sidebarItemAffordance", () => {
  it("returns 'none' when no flags are set", () => {
    const result: SidebarItemAffordance = sidebarItemAffordance({});
    expect(result).toBe("none");
  });

  it("returns 'none' when both flags are explicitly false", () => {
    expect(sidebarItemAffordance({ external: false, isReturn: false })).toBe("none");
  });

  it("returns 'external' when external is true and isReturn is absent", () => {
    expect(sidebarItemAffordance({ external: true })).toBe("external");
  });

  it("returns 'external' when external is true and isReturn is false", () => {
    expect(sidebarItemAffordance({ external: true, isReturn: false })).toBe("external");
  });

  it("returns 'return' when isReturn is true", () => {
    expect(sidebarItemAffordance({ isReturn: true })).toBe("return");
  });

  it("isReturn takes precedence over external when both are true", () => {
    // The 'back to app' item is isReturn AND could theoretically be external;
    // isReturn is the stronger semantic signal and wins.
    expect(sidebarItemAffordance({ external: true, isReturn: true })).toBe("return");
  });
});
