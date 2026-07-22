import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { skillVersionGet } from "./skill.version.get";

const ARTIFACT = {
  schema_version: 1 as const,
  kind: "skill" as const,
  name: "test-skill",
  description: "A test skill",
  instructions: "Test instructions",
  references: ["references/guide.md"],
};

function output(overrides: Record<string, unknown> = {}) {
  return {
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
    content: 'schema_version = 1\nkind = "skill"\n',
    artifact: ARTIFACT,
    referencesPayload: [{ path: "references/guide.md", body: "" }],
    changeSummary: null,
    checksum: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    createdBy: "u_1",
    ...overrides,
  };
}

describe("skill.version.get capability", () => {
  it("accepts a skill with or without an explicit version", () => {
    expect(
      skillVersionGet.input.parse({
        skill_id: "skl_abc",
        version_id: "slv_001",
      }).version_id,
    ).toBe("slv_001");
    expect(
      skillVersionGet.input.parse({ skill_id: "skl_abc" }).version_id,
    ).toBeUndefined();
  });

  it("rejects missing or non-string skill identifiers", () => {
    expect(() => skillVersionGet.input.parse({})).toThrow();
    expect(() => skillVersionGet.input.parse({ skill_id: 123 })).toThrow();
  });

  it("parses canonical content and artifact projections", () => {
    const parsed = skillVersionGet.output.parse(output());
    expect(parsed.content).toContain("schema_version");
    expect(parsed.artifact.name).toBe("test-skill");
    expect(parsed.referencesPayload).toHaveLength(1);
  });

  it("accepts null authors and arbitrary reference projection entries", () => {
    const parsed = skillVersionGet.output.parse(
      output({
        createdBy: null,
        referencesPayload: [{ type: "graph_node", id: "node_1" }],
      }),
    );
    expect(parsed.createdBy).toBeNull();
  });

  it("rejects a missing artifact or malformed timestamp", () => {
    const withoutArtifact = output();
    delete (withoutArtifact as Partial<typeof withoutArtifact>).artifact;
    expect(() => skillVersionGet.output.parse(withoutArtifact)).toThrow();
    expect(() =>
      skillVersionGet.output.parse(output({ createdAt: "not-a-date" })),
    ).toThrow();
  });

  it("is registered as a no-billing capability", () => {
    expect(getCapability("get_skill_version")).toBe(skillVersionGet);
    expect(skillVersionGet.noBillingGate).toBe(true);
  });
});
