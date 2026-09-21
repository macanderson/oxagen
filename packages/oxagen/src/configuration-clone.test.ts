import { describe, expect, it } from "vitest";
import { configurationCloneName } from "./configuration-clone";
describe("clone names", () => {
  it("uses distinct deterministic names and preserves suffixes at identifier limits", () => {
    expect(configurationCloneName("review", "Review", 0, 48)).toEqual({
      slug: "review-cloned",
      name: "Review-cloned",
    });
    expect(configurationCloneName("review", "Review", 1, 48)).toEqual({
      slug: "review-cloned-1",
      name: "Review-cloned-1",
    });
    const limited = configurationCloneName(
      "a".repeat(18),
      "N".repeat(200),
      99,
      18,
    );
    expect(limited.slug).toHaveLength(18);
    expect(limited.slug).toMatch(/-cloned-99$/);
    expect(limited.name).toHaveLength(200);
  });
});
