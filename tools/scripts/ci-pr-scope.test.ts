/**
 * The heavy-lane decision for pipeline.yml (#4918). A draft and a
 * documentation-only pull request skip `build`, `unit`, `e2e`,
 * `rls-integration` and `rds-compatibility`; every other run keeps them, and
 * every doubt resolves to running them. `test` always runs (#5094).
 */
import { describe, expect, it } from "vitest";
import { MAX_FILES, decideScope, isDocsPath, readPullRequestFiles, run } from "./ci-pr-scope.mjs";

type Call = { url: string };

/** A fetch that answers each page of the files endpoint from `pages`. */
function pagedFetch(pages: unknown[], calls: Call[] = []) {
  return async (url: string | URL | Request) => {
    const href = String(url);
    calls.push({ url: href });
    const page = Number(new URL(href).searchParams.get("page"));
    const value = pages[page - 1] ?? [];
    if (value instanceof Error) throw value;
    if (typeof value === "number") return { ok: false, status: value } as never;
    return { ok: true, json: async () => value } as never;
  };
}

const files = (...names: string[]) => names.map((filename) => ({ filename }));

describe("isDocsPath", () => {
  it.each([
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "CLAUDE.md",
    "docs/guides/contained-runs.md",
    "docs/specs/oxagen-desktop/spec.html",
    "docs/reviews/stale-squash-3485/summary.json",
    "releases/v2.1.3.md",
    "apps/desktop/README.md",
    "apps/app/CLAUDE.md",
    "apps/app/AGENTS.md",
    "packages/tacho/README.md",
    ".claude/skills/clear-prose/SKILL.md",
    ".claude/commands/review.md",
    ".agents/skills/x/SKILL.md",
    ".cursor/rules/house.mdc",
  ])("reads %s as documentation", (path) => {
    expect(isDocsPath(path)).toBe(true);
  });

  it.each([
    // The tools/scripts tests in the unit lane read it.
    "AGENTS.md",
    // Read by @oxagen/docs#build and by the capability checks.
    "docs/adr/ADR-045-pin-cross-repo-reusable-workflows.md",
    "docs/capabilities/schemas/seal_run.json",
    "docs/capabilities/seal_run.md",
    // Declared inputs of the cached tools/scripts tests.
    ".claude/workflows/fix-prs.md",
    // Site sources, built by the build lane.
    "apps/docs/content/docs/cli/desktop.mdx",
    "apps/docs/content/docs/cli/notes.md",
    "apps/web/read/index.md",
    // Issue templates the DoD tests read, and the workflows themselves.
    ".github/ISSUE_TEMPLATE/task.md",
    ".github/pull_request_template.md",
    ".github/workflows/pipeline.yml",
    // Fixtures a test compares byte for byte.
    "packages/oxagen/fixtures/steering-repo/repo/CLAUDE.md",
    "packages/x/test/expected.md",
    "packages/x/src/__tests__/golden.md",
    // Markdown that is not a known documentation file.
    "packages/agent/src/prompts/system.md",
    "apps/cli/templates/init.md",
    // Code.
    "packages/tacho/src/index.ts",
    "package.json",
    "pnpm-lock.yaml",
    "turbo.json",
    "README.MD",
    // Not a repository path.
    "",
    "/etc/passwd.md",
    "docs/../package.json",
  ])("reads %s as code", (path) => {
    expect(isDocsPath(path)).toBe(false);
  });
});

describe("decideScope", () => {
  it("runs every lane for every event that is not a pull request", () => {
    for (const eventName of ["push", "merge_group", "workflow_dispatch", "schedule", undefined]) {
      expect(decideScope({ eventName, draft: true, files: ["README.md"] }).heavy).toBe(true);
    }
  });

  it("skips the heavy lanes on a draft without reading its files", () => {
    expect(decideScope({ eventName: "pull_request", draft: true })).toMatchObject({
      heavy: false,
      reason: expect.stringMatching(/draft/),
    });
  });

  it("skips the heavy lanes when every changed file is documentation", () => {
    expect(
      decideScope({ eventName: "pull_request", files: ["README.md", "docs/guides/a.md"] }),
    ).toMatchObject({ heavy: false });
  });

  it("runs every lane when one changed file is code", () => {
    const verdict = decideScope({
      eventName: "pull_request",
      files: ["README.md", "packages/tacho/src/index.ts"],
    });
    expect(verdict.heavy).toBe(true);
    expect(verdict.reason).toContain("packages/tacho/src/index.ts");
  });

  it("runs every lane when the file list could not be read, and says why", () => {
    const verdict = decideScope({ eventName: "pull_request", error: "HTTP 502" });
    expect(verdict.heavy).toBe(true);
    expect(verdict.warning).toContain("HTTP 502");
    expect(decideScope({ eventName: "pull_request" }).heavy).toBe(true);
  });

  it("runs every lane for a pull request that lists no files", () => {
    expect(decideScope({ eventName: "pull_request", files: [] }).heavy).toBe(true);
  });
});

describe("readPullRequestFiles", () => {
  const base = { repository: "o/r", token: "t", number: 7 };

  it("reads every page and stops at the first short one", async () => {
    const calls: Call[] = [];
    const full = Array.from({ length: 100 }, (_, i) => ({ filename: `docs/a${i}.md` }));
    const result = await readPullRequestFiles({
      ...base,
      expected: 101,
      fetchImpl: pagedFetch([full, files("README.md"), files("never-read.ts")], calls),
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain("/repos/o/r/pulls/7/files?per_page=100&page=1");
    expect("files" in result && result.files).toHaveLength(101);
  });

  it("adds the old path of a renamed file", async () => {
    const result = await readPullRequestFiles({
      ...base,
      expected: 1,
      fetchImpl: pagedFetch([
        [{ filename: "docs/moved.md", previous_filename: "packages/x/src/moved.ts" }],
      ]),
    });
    expect(result).toEqual({ files: ["docs/moved.md", "packages/x/src/moved.ts"] });
  });

  it("reports a count that disagrees with the pull request", async () => {
    const result = await readPullRequestFiles({
      ...base,
      expected: 3,
      fetchImpl: pagedFetch([files("README.md")]),
    });
    expect(result).toEqual({ error: "listed 1 files where the pull request reports 3" });
  });

  it("refuses a pull request larger than the endpoint lists", async () => {
    const calls: Call[] = [];
    const result = await readPullRequestFiles({
      ...base,
      expected: MAX_FILES + 1,
      fetchImpl: pagedFetch([], calls),
    });
    expect("error" in result).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("reports an HTTP error, a malformed answer and a thrown fetch, and never throws", async () => {
    await expect(
      readPullRequestFiles({ ...base, fetchImpl: pagedFetch([500]) }),
    ).resolves.toEqual({ error: "HTTP 500" });
    await expect(
      readPullRequestFiles({ ...base, fetchImpl: pagedFetch([{ message: "x" }]) }),
    ).resolves.toEqual({ error: "the files response was not a list" });
    await expect(
      readPullRequestFiles({ ...base, fetchImpl: pagedFetch([[{ status: "added" }]]) }),
    ).resolves.toEqual({ error: "a listed file carried no filename" });
    await expect(
      readPullRequestFiles({ ...base, fetchImpl: pagedFetch([new Error("socket hang up")]) }),
    ).resolves.toEqual({ error: "socket hang up" });
  });
});

describe("run", () => {
  const env = {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REPOSITORY: "o/r",
    GH_TOKEN: "t",
    PR_NUMBER: "7",
    PR_DRAFT: "false",
  };

  it("runs every lane on a push to main with nothing else set", async () => {
    await expect(run({ GITHUB_EVENT_NAME: "push" })).resolves.toMatchObject({ heavy: true });
  });

  it("skips on a draft", async () => {
    await expect(run({ ...env, PR_DRAFT: "true" })).resolves.toMatchObject({ heavy: false });
  });

  it("runs every lane when the pull request number or token is missing", async () => {
    await expect(run({ ...env, PR_NUMBER: "" })).resolves.toMatchObject({ heavy: true });
    await expect(run({ ...env, GH_TOKEN: undefined })).resolves.toMatchObject({ heavy: true });
  });
});
