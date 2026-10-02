import { describe, expect, it, vi } from "vitest";
import { githubCodeHost, gitlabCodeHost, type PostedCheck } from "./host";
import { buildReport } from "./report";

const REPEAT = {
  kind: "repeat" as const,
  statement: { path: "CLAUDE.md", line: 3, text: "Run every tenant query inside withTenantDb." },
  record: { lineage: "a-intel.platform.tenant-queries", label: null, path: null },
};

function check(blockMerge: boolean): PostedCheck {
  return {
    headSha: "9b1f6c0d2e3a4b5c6d7e8f90a1b2c3d4e5f60718",
    report: buildReport({
      workspace: "platform",
      files: ["CLAUDE.md"],
      findings: [REPEAT],
      blockMerge,
      memories: 0,
    }),
    startedAt: "2026-10-02T14:12:10.000Z",
    completedAt: "2026-10-02T14:12:12.000Z",
    workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
  };
}

describe("githubCodeHost", () => {
  function client() {
    return {
      compareCommits: vi.fn(async () => [
        { path: "CLAUDE.md", previousPath: null, status: "modified" as const, additions: 2, deletions: 0, changes: 2, patch: null },
        { path: "OLD.md", previousPath: null, status: "removed" as const, additions: 0, deletions: 4, changes: 4, patch: null },
        { path: ".cursor/rules/new.mdc", previousPath: ".cursor/rules/old.mdc", status: "renamed" as const, additions: 0, deletions: 0, changes: 0, patch: null },
      ]),
      getFileContent: vi.fn(async () => "text"),
      createCheckRun: vi.fn(async () => ({ id: 1, htmlUrl: "https://github.com/a-intel/platform/runs/1" })),
    };
  }

  it("lists the paths that exist at the head, from the merge base", async () => {
    const gh = client();
    const host = githubCodeHost(gh, "a-intel/platform");
    await expect(host.changedPaths("base-sha", "head-sha")).resolves.toEqual([
      "CLAUDE.md",
      ".cursor/rules/new.mdc",
    ]);
    expect(gh.compareCommits).toHaveBeenCalledWith({
      owner: "a-intel",
      repo: "platform",
      base: "base-sha",
      head: "head-sha",
    });
    await host.readFile("CLAUDE.md", "head-sha");
    expect(gh.getFileContent).toHaveBeenCalledWith({
      owner: "a-intel",
      repo: "platform",
      path: "CLAUDE.md",
      ref: "head-sha",
    });
  });

  it("posts a completed check run named Oxagen: neutral to warn, failure to block", async () => {
    const gh = client();
    const host = githubCodeHost(gh, "a-intel/platform");
    await host.postCheck(check(false));
    await host.postCheck(check(true));
    expect(gh.createCheckRun).toHaveBeenNthCalledWith(1, {
      owner: "a-intel",
      repo: "platform",
      name: "Oxagen",
      headSha: "9b1f6c0d2e3a4b5c6d7e8f90a1b2c3d4e5f60718",
      status: "completed",
      conclusion: "neutral",
      title: "1 finding in instruction files",
      summary: expect.stringContaining("- Repeat: `CLAUDE.md` line 3"),
      externalId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
      startedAt: "2026-10-02T14:12:10.000Z",
      completedAt: "2026-10-02T14:12:12.000Z",
    });
    expect(gh.createCheckRun).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: "Oxagen", conclusion: "failure" }),
    );
  });
});

describe("gitlabCodeHost", () => {
  function client() {
    return {
      compare: vi.fn(async () => [
        { oldPath: "AGENTS.md", newPath: "AGENTS.md", renamed: false, deleted: false, added: false },
        { oldPath: "CLAUDE.md", newPath: "CLAUDE.md", renamed: false, deleted: true, added: false },
      ]),
      getFileRaw: vi.fn(async () => null),
      setCommitStatus: vi.fn(async () => ({ id: 1, targetUrl: null })),
    };
  }

  it("lists the paths that exist at the head and reads a file at a ref", async () => {
    const gl = client();
    const host = gitlabCodeHost(gl, "4242");
    await expect(host.changedPaths("main", "head-sha")).resolves.toEqual(["AGENTS.md"]);
    expect(gl.compare).toHaveBeenCalledWith({ project: "4242", from: "main", to: "head-sha" });
    await expect(host.readFile("AGENTS.md", "main")).resolves.toBeNull();
    expect(gl.getFileRaw).toHaveBeenCalledWith({ project: "4242", path: "AGENTS.md", ref: "main" });
  });

  it("posts a commit status named Oxagen: success to warn, failed to block", async () => {
    const gl = client();
    const host = gitlabCodeHost(gl, "4242");
    await host.postCheck(check(false));
    await host.postCheck(check(true));
    expect(gl.setCommitStatus).toHaveBeenNthCalledWith(1, {
      project: "4242",
      sha: "9b1f6c0d2e3a4b5c6d7e8f90a1b2c3d4e5f60718",
      state: "success",
      name: "Oxagen",
      description: "1 finding in instruction files. This check only warns.",
    });
    expect(gl.setCommitStatus).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: "Oxagen", state: "failed" }),
    );
  });
});
