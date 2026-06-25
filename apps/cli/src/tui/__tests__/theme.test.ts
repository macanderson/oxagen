import { describe, it, expect } from "vitest";
import { theme } from "../theme.js";

describe("theme", () => {
  it("exposes the Oxagen brand palette and glyphs", () => {
    expect(theme.cyan).toBe("#7CE8F4");
    expect(theme.violet).toBe("#7C5AED");
    expect(theme.ring).toBe("◯");
    expect(theme.pointer).toBe("❯");
  });
});
