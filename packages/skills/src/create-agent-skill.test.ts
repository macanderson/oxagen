import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkill } from "./loader";

// The builtin create-agent skill is the single source of truth for how the
// agent.definition.suggest handler turns a description into a config. It must
// always parse as valid canonical TOML so the seeder and the handler's filesystem
// fallback can load it.
const SKILL_PATH = join(
  fileURLToPath(import.meta.url),
  "../../skills/create-agent/skill.toml",
);

describe("create-agent builtin skill", () => {
  it("parses via parseSkill with the expected metadata", async () => {
    const raw = await readFile(SKILL_PATH, "utf8");
    const skill = parseSkill(raw, { source: "builtin" });

    expect(skill.slug).toBe("create-agent");
    expect(skill.metadata).toBeDefined();
    expect(skill.metadata?.weight).toBe("high");
    expect(skill.metadata?.category).toBe("meta");
    expect(skill.description.length).toBeGreaterThan(10);
    expect(skill.body).toContain("suggest_agent_def");
    // References agent-builder as the interactive deploy counterpart.
    expect(skill.body).toContain("agent-builder");
  });

  it("documents the two-tier equip-vs-recommend model and the slug budget", async () => {
    const raw = await readFile(SKILL_PATH, "utf8");
    const skill = parseSkill(raw, { source: "builtin" });

    // Second tier: connectable recommendations, distinct from equipable tools.
    expect(skill.body).toContain("recommendations");
    expect(skill.body).toContain("CONNECTABLE");
    // The worked example (schema-audit → recommend GitHub + Supabase MCP).
    expect(skill.body).toContain("github/github-mcp-server");
    expect(skill.body).toContain("supabase/supabase-mcp");
    // The 18-char slug budget and its rationale (global agent key ≤ 32).
    expect(skill.body).toContain("18");
    expect(skill.body).toContain("org_ns.workspace_ns.slug");
  });
});
