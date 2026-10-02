import { describe, expect, it } from "vitest";
import { appliesToOf, isInstructionFile } from "./instruction-files";
import { addedStatements, wordCount } from "./statements";

describe("isInstructionFile", () => {
  it.each([
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    "packages/api/CLAUDE.md",
    "services/billing/AGENTS.md",
    ".cursorrules",
    ".cursor/rules/review.mdc",
    "apps/web/.cursor/rules/ui.md",
    ".github/copilot-instructions.md",
    ".github/instructions/tests.instructions.md",
    ".windsurfrules",
    ".windsurf/rules/style.md",
    ".clinerules",
    ".clinerules/deploy.md",
  ])("reads %s as an instruction file", (path) => {
    expect(isInstructionFile(path)).toBe(true);
  });

  it.each([
    "README.md",
    "docs/CLAUDE-notes.md",
    "src/agents.ts",
    ".github/workflows/ci.yml",
    ".github/instructions/tests.md",
    ".cursor/settings.json",
    "my.cursor/rules/x.md",
  ])("reads %s as another file (negative)", (path) => {
    expect(isInstructionFile(path)).toBe(false);
  });
});

describe("appliesToOf", () => {
  it("scopes a nested file to its folder and a root file to nothing", () => {
    expect(appliesToOf("packages/api/CLAUDE.md")).toBe("packages/api/**");
    expect(appliesToOf("CLAUDE.md")).toBeNull();
    expect(appliesToOf(".cursor/rules/review.mdc")).toBeNull();
  });
});

describe("addedStatements", () => {
  const BASE = [
    "# Platform",
    "",
    "- Use pnpm for every install in this repository.",
    "- Run the unit tests before you open a pull request.",
  ].join("\n");

  it("keeps only the list items and paragraphs the head adds, with their head line", () => {
    const head = [
      "# Platform",
      "",
      "- Use pnpm for every install in this repository.",
      "- Run the unit tests before you open a pull request.",
      "- Deploy only from a tagged release on the release",
      "  branch, never from a laptop.",
      "",
      "## Notes",
      "",
      "The staging database resets every Sunday night at",
      "midnight UTC.",
    ].join("\n");
    expect(addedStatements("CLAUDE.md", BASE, head)).toEqual([
      {
        path: "CLAUDE.md",
        line: 5,
        text: "Deploy only from a tagged release on the release branch, never from a laptop.",
      },
      {
        path: "CLAUDE.md",
        line: 10,
        text: "The staging database resets every Sunday night at midnight UTC.",
      },
    ]);
  });

  it("treats every statement of a new file as added", () => {
    expect(addedStatements("AGENTS.md", null, BASE).map((s) => s.line)).toEqual([3, 4]);
  });

  it("makes a whole paragraph new when one of its lines changes", () => {
    const base = "Keep the release notes short and\nwrite them for customers.";
    const head = "Keep the release notes short and\nwrite them for operators.";
    expect(addedStatements("AGENTS.md", base, head)).toEqual([
      {
        path: "AGENTS.md",
        line: 1,
        text: "Keep the release notes short and write them for operators.",
      },
    ]);
  });

  it("skips frontmatter, code blocks, comments, tables, headings, and labels", () => {
    const head = [
      "---",
      "description: Review rules for the API package",
      "globs: packages/api/**",
      "---",
      "## Review rules",
      "<!-- Keep this list short and sorted by priority. -->",
      "```sh",
      "pnpm install --frozen-lockfile in every fresh clone",
      "```",
      "| Rule | Owner and reviewer of record |",
      "| --- | --- |",
      "Rules:",
      "1. Never merge a pull request with a failing check.",
      "- [ ] Ask a reviewer from the API team for every change.",
      "> Quote the incident number in every rollback commit.",
    ].join("\n");
    expect(addedStatements(".cursor/rules/review.mdc", null, head).map((s) => s.text)).toEqual([
      "Never merge a pull request with a failing check.",
      "Ask a reviewer from the API team for every change.",
      "Quote the incident number in every rollback commit.",
    ]);
  });

  it("adds nothing when the pull request only removes lines", () => {
    const head = BASE.split("\n").slice(0, 3).join("\n");
    expect(addedStatements("CLAUDE.md", BASE, head)).toEqual([]);
  });

  it("counts words the way the conflicts check does", () => {
    expect(wordCount("Don't push to `main`!")).toBe(5);
    expect(wordCount("   ")).toBe(0);
  });
});
