import { describe, expect, it } from "vitest";
import { skillVersionGet } from "./skill.version.get";
import { getCapability } from "../registry";

describe("skill.version.get capability", () => {
  // ── input: required fields ─────────────────────────────────────────────────

  it("accepts valid skill_id and version_id", () => {
    const parsed = skillVersionGet.input.parse({
      skill_id: "skl_abc",
      version_id: "slv_001",
    });
    expect(parsed.skill_id).toBe("skl_abc");
    expect(parsed.version_id).toBe("slv_001");
  });

  // ── input: validation ─────────────────────────────────────────────────────

  it("rejects missing skill_id", () => {
    expect(() =>
      skillVersionGet.input.parse({ version_id: "slv_001" }),
    ).toThrow();
  });

  it("accepts missing version_id (resolves the pinned active version)", () => {
    const parsed = skillVersionGet.input.parse({ skill_id: "skl_abc" });
    expect(parsed.version_id).toBeUndefined();
  });

  it("rejects empty input", () => {
    expect(() => skillVersionGet.input.parse({})).toThrow();
  });

  it("rejects non-string skill_id", () => {
    expect(() =>
      skillVersionGet.input.parse({ skill_id: 123, version_id: "slv_001" }),
    ).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a full valid output", () => {
    const parsed = skillVersionGet.output.parse({
      id: "slv_001",
      skill_id: "skl_abc",
      skill_slug: "test-skill",
      skill_name: "Test Skill",
      skill_description: "A test skill",
      skill_source: "tenant",
      installedFromSlug: null,
      versionNumber: 1,
      isLatest: true,
      isActive: true,
      body: "---\nname: test-skill\n---\n# Test Skill",
      frontmatter: { name: "test-skill" },
      referencesPayload: [],
      changeSummary: null,
      checksum: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      createdBy: "u_1",
    });
    expect(parsed.id).toBe("slv_001");
    expect(parsed.skill_id).toBe("skl_abc");
    expect(parsed.versionNumber).toBe(1);
    expect(parsed.isLatest).toBe(true);
    expect(parsed.isActive).toBe(true);
    expect(parsed.body).toContain("Test Skill");
    expect(parsed.frontmatter).toEqual({ name: "test-skill" });
    expect(parsed.referencesPayload).toHaveLength(0);
    expect(parsed.createdBy).toBe("u_1");
  });

  it("accepts null createdBy", () => {
    const parsed = skillVersionGet.output.parse({
      id: "slv_002",
      skill_id: "skl_abc",
      skill_slug: "test-skill",
      skill_name: "Test Skill",
      skill_description: "A test skill",
      skill_source: "tenant",
      installedFromSlug: null,
      versionNumber: 2,
      isLatest: false,
      isActive: false,
      body: "# Body",
      frontmatter: {},
      referencesPayload: [],
      changeSummary: null,
      checksum: null,
      createdAt: "2024-02-01T00:00:00.000Z",
      createdBy: null,
    });
    expect(parsed.createdBy).toBeNull();
  });

  it("accepts non-empty referencesPayload", () => {
    const refs = [
      { type: "graph_node", id: "node_1" },
      { type: "file", path: "/foo/bar.md" },
    ];
    const parsed = skillVersionGet.output.parse({
      id: "slv_003",
      skill_id: "skl_abc",
      skill_slug: "test-skill",
      skill_name: "Test Skill",
      skill_description: "A test skill",
      skill_source: "tenant",
      installedFromSlug: null,
      versionNumber: 3,
      isLatest: true,
      isActive: true,
      body: "# Body",
      frontmatter: { version: "3" },
      referencesPayload: refs,
      changeSummary: null,
      checksum: null,
      createdAt: "2024-03-01T00:00:00.000Z",
      createdBy: "u_2",
    });
    expect(parsed.referencesPayload).toHaveLength(2);
  });

  it("accepts nested frontmatter values", () => {
    const parsed = skillVersionGet.output.parse({
      id: "slv_004",
      skill_id: "skl_abc",
      skill_slug: "test-skill",
      skill_name: "Test Skill",
      skill_description: "A test skill",
      skill_source: "tenant",
      installedFromSlug: null,
      versionNumber: 4,
      isLatest: true,
      isActive: false,
      body: "---\nname: nested\ntags: [a, b]\n---\n",
      frontmatter: { name: "nested", tags: ["a", "b"] },
      referencesPayload: [],
      changeSummary: null,
      checksum: null,
      createdAt: "2024-04-01T00:00:00.000Z",
      createdBy: "u_3",
    });
    expect(parsed.frontmatter["tags"]).toEqual(["a", "b"]);
  });

  it("rejects output missing body field", () => {
    expect(() =>
      skillVersionGet.output.parse({
        id: "slv_001",
        skill_id: "skl_abc",
        skill_slug: "test-skill",
        skill_name: "Test Skill",
        skill_description: "A test skill",
        skill_source: "tenant",
        installedFromSlug: null,
        versionNumber: 1,
        isLatest: true,
        isActive: true,
        frontmatter: {},
        referencesPayload: [],
        changeSummary: null,
        checksum: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        createdBy: null,
      }),
    ).toThrow();
  });

  it("rejects output missing frontmatter", () => {
    expect(() =>
      skillVersionGet.output.parse({
        id: "slv_001",
        skill_id: "skl_abc",
        skill_slug: "test-skill",
        skill_name: "Test Skill",
        skill_description: "A test skill",
        skill_source: "tenant",
        installedFromSlug: null,
        versionNumber: 1,
        isLatest: true,
        isActive: true,
        body: "# Body",
        referencesPayload: [],
        changeSummary: null,
        checksum: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        createdBy: null,
      }),
    ).toThrow();
  });

  it("rejects non-datetime createdAt", () => {
    expect(() =>
      skillVersionGet.output.parse({
        id: "slv_001",
        skill_id: "skl_abc",
        skill_slug: "test-skill",
        skill_name: "Test Skill",
        skill_description: "A test skill",
        skill_source: "tenant",
        installedFromSlug: null,
        versionNumber: 1,
        isLatest: true,
        isActive: true,
        body: "# Body",
        frontmatter: {},
        referencesPayload: [],
        changeSummary: null,
        checksum: null,
        createdAt: "not-a-date",
        createdBy: null,
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("get_skill_version")).toBe(skillVersionGet);
  });

  it("has noBillingGate set", () => {
    expect(skillVersionGet.noBillingGate).toBe(true);
  });

  it("exposes name correctly", () => {
    expect(skillVersionGet.name).toBe("get_skill_version");
  });
});
