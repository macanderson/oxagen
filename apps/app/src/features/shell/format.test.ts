import { describe, expect, it } from "vitest";
import { initials } from "./format";

describe("initials", () => {
  it("takes the first and last word", () => {
    expect(initials("Marcus Bell")).toBe("MB");
    expect(initials("  priya   q natarajan ")).toBe("PN");
    expect(initials("Dana")).toBe("D");
    expect(initials("")).toBe("");
  });
});
