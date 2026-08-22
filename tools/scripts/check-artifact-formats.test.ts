import { describe, expect, it } from "vitest";
import {
  ALLOWLIST,
  allowlistEntryFor,
  isTestFile,
  scanContent,
} from "./check-artifact-formats.mjs";

describe("scanContent", () => {
  it("flags a loader that reintroduces the legacy skill manifest", () => {
    const violations = scanContent(
      "packages/skills/src/loader.ts",
      'const manifest = join(dir, "SKILL.md");\n',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: "packages/skills/src/loader.ts",
      line: 1,
      label: "SKILL.md (legacy skill manifest)",
    });
  });

  it("flags each legacy marker independently", () => {
    const labels = [
      ['const f = "a.skill.md";', ".skill.md (legacy skill file)"],
      ["const skillMd = body;", "skillMd (legacy field name)"],
      ["Authored as YAML frontmatter.", "YAML frontmatter (legacy format)"],
    ] as const;
    for (const [line, label] of labels) {
      const violations = scanContent("packages/skills/src/loader.ts", line);
      expect(violations.map((v) => v.label)).toContain(label);
    }
  });

  it("reports the 1-indexed line number of the offending line", () => {
    const violations = scanContent(
      "packages/skills/src/loader.ts",
      "const a = 1;\nconst b = 2;\nconst c = 'x.skill.md';\n",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(3);
  });

  it("passes canonical TOML loader code", () => {
    expect(
      scanContent(
        "packages/skills/src/loader.ts",
        'const manifest = join(dir, "skill.toml");\n',
      ),
    ).toEqual([]);
  });

  it("allows the one-way migration converter, which reads the legacy shape by design", () => {
    expect(
      scanContent(
        "packages/handlers/src/skill-legacy-migration.ts",
        'const legacy = row.body ?? "SKILL.md"',
      ),
    ).toEqual([]);
  });

  it("allows explicitly historical documentation", () => {
    for (const path of [
      "docs/adr/ADR-008-skills-filesystem-first.md",
      "docs/specs/inventory/handlers-skills.md",
      "docs/superpowers/plans/2026-07-21-toml-artifacts-cutover.md",
      "apps/docs/content/docs/specs-and-plans/skills-marketplace.mdx",
    ]) {
      expect(scanContent(path, "built-ins live as `*.skill.md` files")).toEqual(
        [],
      );
    }
  });

  it("does not allow live customer documentation to teach the legacy format", () => {
    const violations = scanContent(
      "apps/docs/content/docs/agent/skills.mdx",
      "Author skills as Markdown with YAML frontmatter.",
    );
    expect(violations).toHaveLength(1);
  });

  it("does not allow the live skills reference to teach the legacy format", () => {
    expect(
      scanContent("docs/reference/agent-skills.md", "A skill is a `.skill.md`"),
    ).toHaveLength(1);
  });

  it("skips tests, which legitimately assert the legacy format is ignored", () => {
    for (const path of [
      "packages/skills/src/__tests__/loader.test.ts",
      "packages/skills/src/filesystem.test.ts",
      "packages/handlers/src/fixtures/legacy/skill.md",
    ]) {
      expect(scanContent(path, 'writeFile("a.skill.md", "legacy")')).toEqual(
        [],
      );
    }
  });
});

describe("allowlist", () => {
  it("matches directory entries by prefix and file entries exactly", () => {
    expect(
      allowlistEntryFor("docs/adr/ADR-008-skills-filesystem-first.md"),
    ).toBeDefined();
    expect(
      allowlistEntryFor("packages/handlers/src/skill-legacy-migration.ts"),
    ).toBeDefined();
    // A file entry must not match a sibling by prefix.
    expect(
      allowlistEntryFor("packages/handlers/src/skill-legacy-migration.ts.bak"),
    ).toBeUndefined();
    expect(allowlistEntryFor("packages/skills/src/loader.ts")).toBeUndefined();
  });

  it("requires every exemption to carry a reason", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason, `missing reason for ${entry.path}`).toBeTruthy();
    }
  });

  it("stays narrow — no bare-root or wildcard exemptions", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.path).not.toContain("*");
      expect(entry.path.replace(/\/$/, "").split("/").length).toBeGreaterThan(
        1,
      );
    }
  });
});

describe("isTestFile", () => {
  it("recognizes test files and fixture directories", () => {
    expect(isTestFile("packages/skills/src/loader.test.ts")).toBe(true);
    expect(isTestFile("packages/skills/src/__tests__/loader.test.ts")).toBe(
      true,
    );
    expect(isTestFile("packages/handlers/src/fixtures/a.md")).toBe(true);
    expect(isTestFile("packages/skills/src/loader.ts")).toBe(false);
  });
});
