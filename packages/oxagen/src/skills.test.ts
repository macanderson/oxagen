import { describe, expect, it } from "vitest";
import { skillConfigSchema, SKILL_INTERJECTION_TIMEOUT_MS } from "./skills";

describe("skill configuration", () => {
  it("starts off and cannot silently allow an unbound repository", () => {
    expect(skillConfigSchema.parse({})).toMatchObject({
      enabled: false,
      unbound_repo: "ask",
      reflection: { enabled: false, use: "research" },
    });
    expect(SKILL_INTERJECTION_TIMEOUT_MS).toBe(1_800_000);
    expect(skillConfigSchema.safeParse({ unbound_repo: "allow" }).success).toBe(
      false,
    );
    expect(
      skillConfigSchema.safeParse({ reflection: { use: "performance" } })
        .success,
    ).toBe(false);
    expect(
      skillConfigSchema.safeParse({ reflection: { retention_days: 0 } })
        .success,
    ).toBe(false);
  });
  it("refuses ambiguous pins and configuration that grants authority", () => {
    const pin = {
      id: "review",
      version: "1.0.0",
      digest: `sha256:${"a".repeat(64)}`,
    };
    const source = { id: "workspace", path: ".oxagen/skills", skills: [pin] };
    expect(
      skillConfigSchema.safeParse({ sources: [source, source] }).success,
    ).toBe(false);
    expect(
      skillConfigSchema.safeParse({
        sources: [{ ...source, skills: [pin, pin] }],
      }).success,
    ).toBe(false);
    expect(skillConfigSchema.safeParse({ grants: ["*"] }).success).toBe(false);
    expect(
      skillConfigSchema.safeParse({
        sources: [{ ...source, path: "../../private" }],
      }).success,
    ).toBe(false);
    expect(
      skillConfigSchema.safeParse({ search: { budget: -1 } }).success,
    ).toBe(false);
  });
});
