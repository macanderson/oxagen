import { describe, it, expect } from "vitest";
import { cn, formatDuration, formatTokens, formatPercent, formatPercent1 } from "./format";

describe("cn", () => {
  it("joins truthy class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("drops falsy values", () => {
    expect(cn("a", false, undefined, null, "b")).toBe("a b");
  });

  it("merges conflicting tailwind classes (last wins)", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });
});

describe("formatDuration", () => {
  it("formats sub-second values as ms", () => {
    expect(formatDuration(450)).toBe("450ms");
  });

  it("formats seconds with one decimal", () => {
    expect(formatDuration(4200)).toBe("4.2s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(95_000)).toBe("1m 35s");
  });
});

describe("formatTokens", () => {
  it("formats small counts verbatim", () => {
    expect(formatTokens(420)).toBe("420");
  });

  it("formats thousands with a k suffix", () => {
    expect(formatTokens(3400)).toBe("3.4k");
  });

  it("formats millions with an M suffix", () => {
    expect(formatTokens(2_500_000)).toBe("2.50M");
  });
});

describe("formatPercent", () => {
  it("rounds to a whole percent", () => {
    expect(formatPercent(0.924)).toBe("92%");
  });
});

describe("formatPercent1", () => {
  it("keeps one decimal place", () => {
    expect(formatPercent1(0.924)).toBe("92.4%");
  });
});
