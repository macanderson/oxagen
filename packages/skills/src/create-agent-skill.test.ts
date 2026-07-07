import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkill } from "./loader";

// The builtin create-agent skill is the single source of truth for how the
// agent.definition.suggest handler turns a description into a config. It must
// always parse as a valid .skill.md so the seeder and the handler's filesystem
// fallback can load it.
const SKILL_PATH = join(
  fileURLToPath(import.meta.url),
  "../../skills/create-agent.skill.md",
);

describe("create-agent builtin skill", () => {
  it("parses via parseSkill with the expected frontmatter", async () => {
    const raw = await readFile(SKILL_PATH, "utf8");
    const skill = parseSkill(raw, { source: "builtin" });

    expect(skill.slug).toBe("create-agent");
    expect(skill.metadata.weight).toBe("high");
    expect(skill.metadata.category).toBe("meta");
    expect(skill.description.length).toBeGreaterThan(10);
    expect(skill.body).toContain("agent.definition.suggest");
    // References agent-builder as the interactive deploy counterpart.
    expect(skill.body).toContain("agent-builder");
  });
});
