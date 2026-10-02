// code-repo-check/instruction-files.ts: which files in a code repository are
// harness instruction files (steering-repo-spec, Code repository checks).
//
// Each harness reads its own files. Claude Code reads CLAUDE.md, Codex reads
// AGENTS.md, Gemini CLI reads GEMINI.md, Cursor reads .cursor/rules/ and the
// older .cursorrules, GitHub Copilot reads .github/copilot-instructions.md
// and .github/instructions/, Windsurf reads .windsurf/rules/ and
// .windsurfrules, and Cline reads .clinerules. Stella reads AGENTS.md and
// CLAUDE.md. The three Markdown files apply at any depth, because a harness
// reads the one nearest the code it works on.

/** Instruction files that apply at any depth of the repository. */
const NESTED_NAMES = new Set([
  "AGENTS.md",
  "AGENTS.override.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  "GEMINI.md",
]);

/** Single files a harness reads, wherever they sit. */
const SINGLE_FILES = new Set([".cursorrules", ".windsurfrules", ".clinerules"]);

/** Folders whose Markdown files are rules, wherever the folder sits. */
const RULE_FOLDERS = [".cursor/rules/", ".windsurf/rules/", ".clinerules/"];

/** Is this path, as the host names it, a harness instruction file? */
export function isInstructionFile(path: string): boolean {
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? "";
  if (NESTED_NAMES.has(name) || SINGLE_FILES.has(name)) return true;
  if (path === ".github/copilot-instructions.md") return true;
  if (path.startsWith(".github/instructions/") && name.endsWith(".instructions.md"))
    return true;
  const slashed = `/${path}`;
  return (
    (name.endsWith(".md") || name.endsWith(".mdc")) &&
    RULE_FOLDERS.some((folder) => slashed.includes(`/${folder}`))
  );
}

/**
 * The path glob a nested instruction file applies to, or null for a file
 * that applies to the whole repository. `packages/api/CLAUDE.md` applies to
 * `packages/api/**`.
 */
export function appliesToOf(path: string): string | null {
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? "";
  if (!NESTED_NAMES.has(name) || segments.length < 2) return null;
  return `${segments.slice(0, -1).join("/")}/**`;
}
