/**
 * #4055: ADR-015 makes Biome the sole formatter, and nothing checked it. The
 * only Biome run was the pre-commit hook over staged files, so a commit made
 * with `--no-verify`, or a file that arrived through a merge, reached `main`
 * unformatted while CI stayed green. These assertions fail if the whole-tree
 * check drops out of CI or out of the local gate that mirrors it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scripts: Record<string, string> = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
).scripts;
const pipeline = readFileSync(
  join(repoRoot, ".github/workflows/pipeline.yml"),
  "utf8",
);

/**
 * The lines of one job in a workflow: from `  <job>:` to the next job key at
 * the same two-space indent. Comment lines are dropped, so a comment that
 * mentions the command cannot stand in for the step.
 */
function jobLines(workflow: string, job: string): string[] {
  const lines = workflow.split("\n");
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}[A-Za-z][\w-]*:\s*$/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).filter(
    (l) => !/^\s*#/.test(l),
  );
}

describe("jobLines", () => {
  const workflow = [
    "jobs:",
    "  checks:",
    "    steps:",
    "      # pnpm format:check (a comment, not a step)",
    "      - name: Lint",
    "        run: pnpm lint",
    "  build:",
    "    steps:",
    "      - run: pnpm format:check",
  ].join("\n");

  it("stops at the next job and drops comments", () => {
    expect(jobLines(workflow, "checks")).toEqual([
      "    steps:",
      "      - name: Lint",
      "        run: pnpm lint",
    ]);
  });

  it("returns nothing for a job that is not there", () => {
    expect(jobLines(workflow, "missing")).toEqual([]);
  });
});

describe("Biome formatting is checked (#4055)", () => {
  it("format:check checks the whole tree and names the fix", () => {
    expect(scripts["format:check"]).toMatch(/^biome format \. /);
    expect(scripts["format:check"]).not.toContain("--write");
    // Biome stops listing files after 20 by default, so a failure with more
    // drifted files than that would not name them all.
    expect(scripts["format:check"]).toContain("--max-diagnostics=none");
    expect(scripts["format:check"]).toContain("pnpm format");
    // The fallback must still fail the script after printing the fix.
    expect(scripts["format:check"]).toMatch(/exit 1\)$/);
  });

  it.each(["gate", "gate:full"])("pnpm %s runs format:check", (name) => {
    expect(scripts[name]).toContain("&& pnpm format:check &&");
  });

  it("the checks job runs format:check over the whole tree on every run", () => {
    const lines = jobLines(pipeline, "checks");
    expect(lines.length).toBeGreaterThan(0);
    const run = lines.filter((l) => /\bpnpm format:check\b/.test(l));
    expect(run).toHaveLength(1);
    // Not behind the affected-package filter: drift can sit in any file.
    expect(run[0]).not.toContain("TURBO_FILTER");
    expect(run[0]).toMatch(/^\s+run: pnpm format:check\s*$/);
  });
});
