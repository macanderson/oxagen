// This test reads the clear-prose and oxagen-branding skill files under
// .claude/skills in the live tree. vitest.config.ts leaves `*.tree.test.ts`
// files out of turbo's cached tasks, so `pnpm check:tree-guards` runs them
// uncached in the checks job (#4664 item 2).
import { describe, expect, it } from "vitest";
import { loadSkills, SKILL_FILES, systemPrompt } from "./lib/release-notes";

const ROOT = new URL("../../", import.meta.url).pathname;

describe("the model's instructions", () => {
  it("are the two writing skills, read from the tree", () => {
    const skills = loadSkills(ROOT);
    for (const rel of SKILL_FILES)
      expect(skills).toContain(`<skill path="${rel}">`);
    expect(skills).toContain("No em dashes");
    const system = systemPrompt(skills);
    expect(system).toContain("workforce management for autonomous agents");
    expect(system).toContain("SUMMARY:");
    expect(system).toContain("## What changed");
    expect(system).toContain("Do not list every commit");
  });
});
