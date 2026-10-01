// This test reads the clear-prose skill under .claude/skills in the live tree.
// vitest.config.ts leaves `*.tree.test.ts` files out of turbo's cached tasks,
// so `pnpm check:tree-guards` runs them uncached in the checks job (#4664
// item 2). The branding references come from a fake kit here, because the
// real ones live in macanderson/oxagen-brand (#4804).
import { describe, expect, it } from "vitest";
import {
  BRAND_KIT_REPO,
  KIT_SKILL_FILES,
  loadSkills,
  systemPrompt,
  TREE_SKILL_FILES,
} from "./lib/release-notes";

const ROOT = new URL("../../", import.meta.url).pathname;
const KIT_SHA = "3ab3085aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("the model's instructions", () => {
  it("are clear-prose from the tree and the branding references from the kit", async () => {
    const skills = await loadSkills(ROOT, {
      head: () => KIT_SHA,
      fetch: async (url) => new Response(`# ${url.split("/").pop()} from the kit\n`),
    });
    for (const rel of TREE_SKILL_FILES)
      expect(skills).toContain(`<skill path="${rel}">`);
    for (const rel of KIT_SKILL_FILES)
      expect(skills).toContain(
        `<skill path="${BRAND_KIT_REPO}@${KIT_SHA}/${rel}">`,
      );
    expect(skills).toContain("No em dashes");
    const system = systemPrompt(skills);
    expect(system).toContain("workforce management for autonomous agents");
    expect(system).toContain("SUMMARY:");
    expect(system).toContain("## What changed");
    expect(system).toContain("Do not list every commit");
  });
});
