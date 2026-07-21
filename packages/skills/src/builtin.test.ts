import { describe, expect, it } from "vitest";
import {
  embeddedBuiltinSkills,
  builtinSkillSlugs,
  createBuiltinSkillRegistry,
} from "./builtin";
import type { Skill } from "./types";

// These skills are the platform-global defaults seeded into every workspace.
// The create-agent slug in particular MUST always resolve — its absence is the
// exact "no tenant copy and no builtin on disk" failure this module prevents.
const REQUIRED_SLUGS = [
  "create-agent",
  "agent-builder",
  "skill-builder",
  "coding",
  "debugging",
  "iam-rbac-setup",
  "swarm-research",
  "ci-fixer",
  "brand-voice-design",
];

describe("embeddedBuiltinSkills", () => {
  it("parses every embedded builtin with a non-empty body and builtin source", () => {
    const skills = embeddedBuiltinSkills();
    expect(skills.length).toBeGreaterThanOrEqual(REQUIRED_SLUGS.length);
    for (const skill of skills) {
      expect(skill.body.trim().length).toBeGreaterThan(0);
      expect(skill.description.trim().length).toBeGreaterThan(0);
      expect(skill.source).toBe("builtin");
    }
  });

  it("includes every required foundational skill slug", () => {
    const slugs = new Set(builtinSkillSlugs());
    for (const slug of REQUIRED_SLUGS) {
      expect(slugs.has(slug)).toBe(true);
    }
  });

  it("resolves create-agent with a substantial body (the un-brickable fallback)", () => {
    const createAgent = embeddedBuiltinSkills().find(
      (s: Skill) => s.slug === "create-agent",
    );
    expect(createAgent).toBeDefined();
    // The body is the system prompt for agent.definition.suggest — it must be real.
    expect(createAgent!.body.length).toBeGreaterThan(500);
  });

  it("teaches the canonical TOML skill contract", () => {
    const skillBuilder = embeddedBuiltinSkills().find(
      (skill: Skill) => skill.slug === "skill-builder",
    );
    expect(skillBuilder?.body).toContain("skill.toml");
    expect(skillBuilder?.body).toContain("schema_version = 1");
    expect(skillBuilder?.body).toContain("references =");
    expect(skillBuilder?.body).not.toContain("*.skill.md");
    expect(skillBuilder?.body).not.toContain(
      "A skill is a single `*.skill.md`",
    );
  });

  it("returns a fresh array each call (no shared mutable state)", () => {
    const a = embeddedBuiltinSkills();
    const b = embeddedBuiltinSkills();
    expect(a).not.toBe(b);
    expect(a.map((s) => s.slug).sort()).toEqual(b.map((s) => s.slug).sort());
  });
});

describe("createBuiltinSkillRegistry", () => {
  it("gets a builtin by slug without touching the filesystem", async () => {
    const registry = createBuiltinSkillRegistry();
    const skill = await registry.get("create-agent");
    expect(skill?.slug).toBe("create-agent");
    expect(skill?.body.trim().length).toBeGreaterThan(0);
  });

  it("lists all builtins and filters by needle", async () => {
    const registry = createBuiltinSkillRegistry();
    const all = await registry.list();
    expect(all.length).toBeGreaterThanOrEqual(REQUIRED_SLUGS.length);
    const filtered = await registry.list("agent");
    expect(filtered.some((s) => s.slug === "create-agent")).toBe(true);
    expect(filtered.length).toBeLessThan(all.length);
  });

  it("lets a tenant skill shadow a builtin on slug collision", async () => {
    const tenantCreateAgent: Skill = {
      slug: "create-agent",
      name: "create-agent",
      description: "tenant override",
      metadata: undefined,
      body: "TENANT BODY",
      references: [],
      source: "tenant",
      version: "2.0.0",
    };
    const registry = createBuiltinSkillRegistry(async () => [
      tenantCreateAgent,
    ]);
    const resolved = await registry.get("create-agent");
    expect(resolved?.source).toBe("tenant");
    expect(resolved?.body).toBe("TENANT BODY");
  });
});
