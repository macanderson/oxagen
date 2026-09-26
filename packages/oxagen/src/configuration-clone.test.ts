import { describe, expect, it } from "vitest";
import {
  configurationCloneDraftSchema,
  configurationCloneName,
  configurationKindSchema,
} from "./configuration-clone";

describe("clone kinds", () => {
  it("clones skills and records, never an agent (ADR-192)", () => {
    expect(configurationKindSchema.options).toEqual(["skill", "record"]);
    expect(
      configurationCloneDraftSchema.safeParse({
        kind: "agent",
        sourceId: "review",
        sourceDigest: `sha256:${"a".repeat(64)}`,
        slug: "review-cloned",
        name: "Review-cloned",
        source: "x",
        files: [],
      }).success,
    ).toBe(false);
  });
});

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
  it("caps a record's name at its 36-character label (ADR-178)", () => {
    const label = configurationCloneName(
      "ctx.core.review",
      "Review every changed file before merge",
      0,
      200,
      36,
    );
    expect(label.name).toBe("Review every changed file bef-cloned");
    expect(label.name.length).toBeLessThanOrEqual(36);
    expect(label.slug).toBe("ctx.core.review-cloned");
  });
});
