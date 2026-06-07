/**
 * sidebar-item-affordance.test.ts — unit tests for sidebarItemAffordance.
 */
import { describe, it, expect } from "vitest";
import { sidebarItemAffordance } from "./sidebar-item-affordance";

describe("sidebarItemAffordance", () => {
  it("returns 'return' when isReturn is true", () => {
    expect(sidebarItemAffordance({ isReturn: true })).toBe("return");
  });

  it("returns 'return' when both isReturn and external are true (isReturn takes precedence)", () => {
    expect(sidebarItemAffordance({ isReturn: true, external: true })).toBe("return");
  });

  it("returns 'external' when external is true and isReturn is false", () => {
    expect(sidebarItemAffordance({ external: true })).toBe("external");
  });

  it("returns 'external' when external is true and isReturn is undefined", () => {
    expect(sidebarItemAffordance({ external: true, isReturn: undefined })).toBe("external");
  });

  it("returns 'none' when neither flag is set", () => {
    expect(sidebarItemAffordance({})).toBe("none");
  });

  it("returns 'none' when both flags are false", () => {
    expect(sidebarItemAffordance({ isReturn: false, external: false })).toBe("none");
  });

  it("returns 'none' when external is false and isReturn is false", () => {
    expect(sidebarItemAffordance({ isReturn: false, external: false })).toBe("none");
  });
});
