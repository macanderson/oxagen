import { describe, it, expect } from "vitest";
import type { RepoOption } from "@/components/chat/repo-selector";
import {
  MAX_SANDBOX_REPOS,
  createSandboxRepoRow,
  selectRepoForRow,
  canAddSandboxRepoRow,
  optionsForRow,
  toSandboxRepoInputs,
  type SandboxRepoSelection,
} from "./sandbox-repo-picker";

function makeRepo(overrides: Partial<RepoOption> = {}): RepoOption {
  return {
    key: "conn1::acme/api",
    connectionId: "conn1",
    owner: "acme",
    name: "api",
    defaultBranch: "main",
    ...overrides,
  };
}

function makeRow(
  overrides: Partial<SandboxRepoSelection> = {},
): SandboxRepoSelection {
  return { id: "row1", repoKey: null, branch: "", ...overrides };
}

describe("sandbox-repo-picker helpers", () => {
  it("createSandboxRepoRow returns a fresh, unselected row with a unique id", () => {
    const a = createSandboxRepoRow();
    const b = createSandboxRepoRow();
    expect(a.repoKey).toBeNull();
    expect(a.branch).toBe("");
    expect(a.id).not.toBe(b.id);
  });

  it("selectRepoForRow sets the repo key and prefills branch from the repo's default", () => {
    const row = makeRow();
    const repo = makeRepo({ defaultBranch: "develop" });
    const next = selectRepoForRow(row, repo);
    expect(next.id).toBe(row.id);
    expect(next.repoKey).toBe(repo.key);
    expect(next.branch).toBe("develop");
  });

  it("selectRepoForRow prefills an empty branch when the repo has no default branch", () => {
    const next = selectRepoForRow(makeRow(), makeRepo({ defaultBranch: null }));
    expect(next.branch).toBe("");
  });

  it("canAddSandboxRepoRow allows up to MAX_SANDBOX_REPOS rows", () => {
    const rows = Array.from({ length: MAX_SANDBOX_REPOS - 1 }, (_, i) =>
      makeRow({ id: `r${i}` }),
    );
    expect(canAddSandboxRepoRow(rows)).toBe(true);
    rows.push(makeRow({ id: "last" }));
    expect(rows).toHaveLength(MAX_SANDBOX_REPOS);
    expect(canAddSandboxRepoRow(rows)).toBe(false);
  });

  it("optionsForRow excludes repos already selected by other rows but keeps the row's own pick", () => {
    const repoA = makeRepo({ key: "a", owner: "acme", name: "api" });
    const repoB = makeRepo({ key: "b", owner: "acme", name: "web" });
    const rowA = makeRow({ id: "rowA", repoKey: "a" });
    const rowB = makeRow({ id: "rowB", repoKey: null });
    const options = optionsForRow(rowB, [rowA, rowB], [repoA, repoB]);
    expect(options.map((r) => r.key)).toEqual(["b"]);

    // The row holding "a" still sees it in its own option list.
    const optionsForA = optionsForRow(rowA, [rowA, rowB], [repoA, repoB]);
    expect(optionsForA.map((r) => r.key)).toEqual(["a", "b"]);
  });

  it("toSandboxRepoInputs resolves selected rows to {owner, repo, branch?} and drops empty rows", () => {
    const repoA = makeRepo({
      key: "a",
      owner: "acme",
      name: "api",
      defaultBranch: "main",
    });
    const repoB = makeRepo({
      key: "b",
      owner: "acme",
      name: "web",
      defaultBranch: "main",
    });
    const rows: SandboxRepoSelection[] = [
      makeRow({ id: "r1", repoKey: "a", branch: "main" }),
      makeRow({ id: "r2", repoKey: null }), // empty row — dropped
      makeRow({ id: "r3", repoKey: "b", branch: "  " }), // blank branch — omitted, not " "
    ];
    const out = toSandboxRepoInputs(rows, [repoA, repoB]);
    expect(out).toEqual([
      { owner: "acme", repo: "api", branch: "main" },
      { owner: "acme", repo: "web" },
    ]);
  });

  it("toSandboxRepoInputs drops a row whose repoKey no longer resolves to a known repo", () => {
    const row = makeRow({ repoKey: "gone" });
    expect(toSandboxRepoInputs([row], [makeRepo({ key: "a" })])).toEqual([]);
  });

  it("toSandboxRepoInputs never returns more than MAX_SANDBOX_REPOS entries", () => {
    const repos = Array.from({ length: MAX_SANDBOX_REPOS + 2 }, (_, i) =>
      makeRepo({ key: `k${i}`, owner: "acme", name: `repo${i}` }),
    );
    const rows = repos.map((r, i) =>
      makeRow({ id: `row${i}`, repoKey: r.key }),
    );
    expect(toSandboxRepoInputs(rows, repos)).toHaveLength(MAX_SANDBOX_REPOS);
  });
});
