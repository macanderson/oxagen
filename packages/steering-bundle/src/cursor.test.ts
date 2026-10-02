import { describe, expect, it } from "vitest";
import { CURSOR_DASHBOARD_RULE } from "./cursor";

describe("CURSOR_DASHBOARD_RULE", () => {
  it("starts with the line Steering from Oxagen", () => {
    expect(CURSOR_DASHBOARD_RULE.split("\n")[0]).toBe("Steering from Oxagen");
  });

  it("names both steering tools", () => {
    expect(CURSOR_DASHBOARD_RULE).toContain("search_steering");
    expect(CURSOR_DASHBOARD_RULE).toContain("read_steering");
  });

  it("has no em dash", () => {
    expect(CURSOR_DASHBOARD_RULE).not.toContain(String.fromCharCode(0x2014));
  });
});
