import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRules } from "../loader.js";

let dir: string;
let userDir: string;

function writeRule(rel: string, body: string): void {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf8");
}

const load = () => loadRules({ cwd: dir, userRulesDir: userDir });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-rules-"));
  userDir = join(dir, "user-rules");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadRules", () => {
  it("loads a rule with description, guard, and body text", () => {
    writeRule(
      ".oxagen/rules/no-applied-migration.md",
      "---\ndescription: Never edit an applied migration\nguard-tool: Edit\nguard-deny-path: packages/database/migrations/*-applied/**\n---\nAdd a new forward migration instead of editing an applied one.",
    );
    const rules = load();
    expect(rules).toHaveLength(1);
    const r = rules[0]!;
    expect(r.id).toBe("no-applied-migration");
    expect(r.description).toBe("Never edit an applied migration");
    expect(r.guard).toEqual({
      tool: "Edit",
      denyPathGlob: "packages/database/migrations/*-applied/**",
    });
    expect(r.text).toContain("Add a new forward migration");
  });

  it("parses a bash command guard", () => {
    writeRule(
      ".oxagen/rules/no-force-push.md",
      "---\nguard-tool: Bash\nguard-deny-command: git push --force*\n---\nNever force-push.",
    );
    expect(load()[0]?.guard).toEqual({
      tool: "Bash",
      denyCommandGlob: "git push --force*",
    });
  });

  it("treats a rule with no guard frontmatter as prompt-only", () => {
    writeRule(
      ".oxagen/rules/style.md",
      "---\ndescription: d\n---\nMatch the surrounding code style.",
    );
    expect(load()[0]?.guard).toBeUndefined();
  });

  it(".oxagen overrides .claude overrides user by name", () => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "r.md"), "user text");
    writeRule(".claude/rules/r.md", "claude text");
    expect(load().find((x) => x.id === "r")?.text).toBe("claude text");
    writeRule(".oxagen/rules/r.md", "oxagen text");
    expect(load().find((x) => x.id === "r")?.text).toBe("oxagen text");
  });

  it("ignores files with an empty body", () => {
    writeRule(".oxagen/rules/empty.md", "---\ndescription: d\n---\n");
    expect(load()).toHaveLength(0);
  });

  it("returns an empty list when no rules exist", () => {
    expect(load()).toEqual([]);
  });
});
