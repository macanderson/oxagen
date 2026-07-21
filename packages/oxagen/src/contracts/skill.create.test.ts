import { describe, expect, it } from "vitest";
import { skillCreate } from "./skill.create";

describe("skill.create capability", () => {
  it("accepts canonical content and rejects the retired body shape", () => {
    const parsed = skillCreate.input.parse({
      content: 'schema_version = 1\nkind = "skill"',
    });
    expect(parsed.content).toContain("schema_version");
    expect(() =>
      skillCreate.input.parse({ body: "---\nname: old\n---" }),
    ).toThrow();
  });

  it("returns the parsed artifact projection", () => {
    const parsed = skillCreate.output.parse({
      publicId: "skl_1",
      slug: "my-skill",
      activeVersion: 1,
      created: true,
      artifact: {
        schema_version: 1,
        kind: "skill",
        name: "my-skill",
        description: "A skill",
        instructions: "Instructions",
        references: [],
      },
    });
    expect(parsed.artifact.name).toBe("my-skill");
  });
});
