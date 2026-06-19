import { describe, expect, it } from "vitest";
import { skillMetricsRead } from "./skill.metrics.read";
import { getCapability } from "../registry";

describe("skill.metrics.read capability", () => {
  // ── input: defaults ──────────────────────────────────────────────────────────

  it("parses empty input (skillId is optional)", () => {
    const parsed = skillMetricsRead.input.parse({});
    expect(parsed.skillId).toBeUndefined();
  });

  it("accepts a skillId string", () => {
    const parsed = skillMetricsRead.input.parse({ skillId: "skl_abc123" });
    expect(parsed.skillId).toBe("skl_abc123");
  });

  it("rejects a non-string skillId", () => {
    expect(() => skillMetricsRead.input.parse({ skillId: 42 })).toThrow();
  });

  // ── output: valid shapes ─────────────────────────────────────────────────────

  it("parses a valid output with one skill", () => {
    const parsed = skillMetricsRead.output.parse({
      skills: [
        {
          skillId: "skl_abc123",
          slug: "code-audit",
          activeVersion: 3,
          usageCount: 17,
          lastUsedAt: "2026-06-18T12:00:00.000Z",
          approxTokenCost: 4.2,
          perVersionLoads: [
            { version: 3, loads: 12, lastUsed: "2026-06-18T12:00:00.000Z" },
            { version: 2, loads: 5, lastUsed: "2026-06-10T08:00:00.000Z" },
          ],
        },
      ],
    });
    expect(parsed.skills).toHaveLength(1);
    const s = parsed.skills[0]!;
    expect(s.skillId).toBe("skl_abc123");
    expect(s.slug).toBe("code-audit");
    expect(s.activeVersion).toBe(3);
    expect(s.usageCount).toBe(17);
    expect(s.lastUsedAt).toBe("2026-06-18T12:00:00.000Z");
    expect(s.approxTokenCost).toBeCloseTo(4.2);
    expect(s.perVersionLoads).toHaveLength(2);
    expect(s.perVersionLoads[0]).toEqual({
      version: 3,
      loads: 12,
      lastUsed: "2026-06-18T12:00:00.000Z",
    });
  });

  it("parses a skill with nullable activeVersion, lastUsedAt and approxTokenCost", () => {
    const parsed = skillMetricsRead.output.parse({
      skills: [
        {
          skillId: "skl_new",
          slug: "new-skill",
          activeVersion: null,
          usageCount: 0,
          lastUsedAt: null,
          approxTokenCost: null,
          perVersionLoads: [],
        },
      ],
    });
    const s = parsed.skills[0]!;
    expect(s.activeVersion).toBeNull();
    expect(s.lastUsedAt).toBeNull();
    expect(s.approxTokenCost).toBeNull();
    expect(s.perVersionLoads).toHaveLength(0);
  });

  it("parses an empty skills array", () => {
    const parsed = skillMetricsRead.output.parse({ skills: [] });
    expect(parsed.skills).toHaveLength(0);
  });

  // ── output: rejection paths ──────────────────────────────────────────────────

  it("rejects a skill missing the slug field", () => {
    expect(() =>
      skillMetricsRead.output.parse({
        skills: [
          {
            skillId: "skl_bad",
            activeVersion: 1,
            usageCount: 0,
            lastUsedAt: null,
            approxTokenCost: null,
            perVersionLoads: [],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a perVersionLoads entry missing version", () => {
    expect(() =>
      skillMetricsRead.output.parse({
        skills: [
          {
            skillId: "skl_x",
            slug: "x",
            activeVersion: 1,
            usageCount: 1,
            lastUsedAt: null,
            approxTokenCost: null,
            perVersionLoads: [{ loads: 1, lastUsed: null }],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects output missing the skills array", () => {
    expect(() => skillMetricsRead.output.parse({})).toThrow();
  });

  // ── registry ─────────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("skill.metrics.read")).toBe(skillMetricsRead);
  });

  // ── contract metadata ────────────────────────────────────────────────────────

  it("is read-only and has noBillingGate=true", () => {
    expect(skillMetricsRead.noBillingGate).toBe(true);
    expect(skillMetricsRead.mode).toBe("sync");
  });

  it("includes api and mcp surfaces", () => {
    expect(skillMetricsRead.surfaces).toContain("api");
    expect(skillMetricsRead.surfaces).toContain("mcp");
  });
});
