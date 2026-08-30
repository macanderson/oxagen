/**
 * Contract shape tests for the five GitHub write capabilities.
 *
 * These tests verify the static shape (metadata + Zod schema) of each contract
 * without importing handlers or touching any external services.
 */
import { describe, it, expect } from "vitest";
import { repoCreate } from "../repo.create";
import { repoFilePut } from "../repo.file.put";
import { repoFork } from "../repo.fork";
import { repoBranchCreate } from "../repo.branch.create";
import { repoPrOpen } from "../repo.pr.open";

// ── Shared metadata assertions ────────────────────────────────────────────────

const ALL_CONTRACTS = [
  repoCreate,
  repoFilePut,
  repoFork,
  repoBranchCreate,
  repoPrOpen,
];

describe("GitHub write contracts — shared metadata", () => {
  it.each(ALL_CONTRACTS.map((c) => [c.name, c] as [string, typeof c]))(
    "%s: riskLevel is high",
    (_name, contract) => {
      expect(contract.agent?.riskLevel).toBe("high");
    },
  );

  it.each(ALL_CONTRACTS.map((c) => [c.name, c] as [string, typeof c]))(
    "%s: includes agent and api surfaces",
    (_name, contract) => {
      expect(contract.surfaces).toContain("agent");
      expect(contract.surfaces).toContain("api");
    },
  );

  it.each(ALL_CONTRACTS.map((c) => [c.name, c] as [string, typeof c]))(
    "%s: category is vcs",
    (_name, contract) => {
      expect(contract.agent?.category).toBe("vcs");
    },
  );

  it.each(ALL_CONTRACTS.map((c) => [c.name, c] as [string, typeof c]))(
    "%s: defaultEffect is deny",
    (_name, contract) => {
      expect(contract.defaultEffect).toBe("deny");
    },
  );

  it.each(ALL_CONTRACTS.map((c) => [c.name, c] as [string, typeof c]))(
    "%s: scoped is true",
    (_name, contract) => {
      expect(contract.scoped).toBe(true);
    },
  );

  it.each(ALL_CONTRACTS.map((c) => [c.name, c] as [string, typeof c]))(
    "%s: requiresApproval is false",
    (_name, contract) => {
      expect(contract.agent?.requiresApproval).toBe(false);
    },
  );
});

// ── 8a: repo.create input schema ─────────────────────────────────────────────

describe("create_repo", () => {
  it("name is create_repo", () => {
    expect(repoCreate.name).toBe("create_repo");
  });

  it("parses a minimal valid input (only name required)", () => {
    const parsed = repoCreate.input.parse({ org: "myorg", name: "myrepo" });
    expect(parsed.org).toBe("myorg");
    expect(parsed.name).toBe("myrepo");
    expect(parsed.description).toBeUndefined();
    expect(parsed.private).toBeUndefined();
    expect(parsed.autoInit).toBeUndefined();
  });

  it("accepts input without org (personal account) and leaves org undefined", () => {
    const parsed = repoCreate.input.parse({ name: "hello-world" });
    expect(parsed.org).toBeUndefined();
    expect(parsed.name).toBe("hello-world");
  });

  it("parses a fully specified input", () => {
    const parsed = repoCreate.input.parse({
      org: "myorg",
      name: "myrepo",
      description: "A repo",
      private: true,
      autoInit: true,
    });
    expect(parsed.description).toBe("A repo");
    expect(parsed.private).toBe(true);
    expect(parsed.autoInit).toBe(true);
  });

  it("rejects input missing name", () => {
    expect(() => repoCreate.input.parse({ org: "myorg" })).toThrow();
  });

  it("output schema includes fullName, htmlUrl, defaultBranch", () => {
    const parsed = repoCreate.output.parse({
      fullName: "myorg/myrepo",
      htmlUrl: "https://github.com/myorg/myrepo",
      defaultBranch: "main",
    });
    expect(parsed.fullName).toBe("myorg/myrepo");
    expect(parsed.htmlUrl).toBe("https://github.com/myorg/myrepo");
    expect(parsed.defaultBranch).toBe("main");
  });
});

// ── repo.file.put ─────────────────────────────────────────────────────────────

describe("put_repo_file", () => {
  it("name is put_repo_file", () => {
    expect(repoFilePut.name).toBe("put_repo_file");
  });

  it("parses a valid input (owner, repo, path, content, message required)", () => {
    const parsed = repoFilePut.input.parse({
      owner: "myorg",
      repo: "myrepo",
      path: "src/index.ts",
      content: "export {};",
      message: "init",
    });
    expect(parsed.owner).toBe("myorg");
    expect(parsed.path).toBe("src/index.ts");
    expect(parsed.branch).toBeUndefined();
  });

  it("rejects input missing content", () => {
    expect(() =>
      repoFilePut.input.parse({
        owner: "x",
        repo: "y",
        path: "z",
        message: "m",
      }),
    ).toThrow();
  });

  it("output schema parses without diffs (backward compatible)", () => {
    const parsed = repoFilePut.output.parse({
      commitSha: "abc123",
      htmlUrl: "https://github.com/myorg/myrepo/blob/main/src/index.ts",
    });
    expect(parsed.diffs).toBeUndefined();
  });

  it("output schema parses the optional diffs field with real patch text", () => {
    const parsed = repoFilePut.output.parse({
      commitSha: "abc123",
      htmlUrl: "https://github.com/myorg/myrepo/blob/main/src/index.ts",
      diffs: [
        {
          path: "src/index.ts",
          patch:
            "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new\n",
          additions: 1,
          deletions: 1,
        },
      ],
    });
    expect(parsed.diffs).toHaveLength(1);
    expect(parsed.diffs?.[0]).toMatchObject({
      path: "src/index.ts",
      additions: 1,
      deletions: 1,
    });
  });

  it("output schema rejects a diffs entry missing required fields", () => {
    expect(() =>
      repoFilePut.output.parse({
        commitSha: "abc123",
        htmlUrl: "https://github.com/myorg/myrepo/blob/main/src/index.ts",
        diffs: [{ path: "src/index.ts" }],
      }),
    ).toThrow();
  });
});

// ── repo.fork ─────────────────────────────────────────────────────────────────

describe("fork_repo", () => {
  it("name is fork_repo", () => {
    expect(repoFork.name).toBe("fork_repo");
  });

  it("parses input with owner and repo (intoOrg optional)", () => {
    const parsed = repoFork.input.parse({ owner: "upstream", repo: "repo" });
    expect(parsed.owner).toBe("upstream");
    expect(parsed.intoOrg).toBeUndefined();
  });

  it("parses input with intoOrg", () => {
    const parsed = repoFork.input.parse({
      owner: "upstream",
      repo: "repo",
      intoOrg: "myorg",
    });
    expect(parsed.intoOrg).toBe("myorg");
  });
});

// ── repo.branch.create ────────────────────────────────────────────────────────

describe("create_branch", () => {
  it("name is create_branch", () => {
    expect(repoBranchCreate.name).toBe("create_branch");
  });

  it("parses a minimal valid input (owner, repo, branch required)", () => {
    const parsed = repoBranchCreate.input.parse({
      owner: "myorg",
      repo: "myrepo",
      branch: "feature/x",
    });
    expect(parsed.branch).toBe("feature/x");
    expect(parsed.fromBranch).toBeUndefined();
  });

  it("output schema includes ref and sha", () => {
    const parsed = repoBranchCreate.output.parse({
      ref: "refs/heads/feature/x",
      sha: "abc123",
    });
    expect(parsed.ref).toBe("refs/heads/feature/x");
    expect(parsed.sha).toBe("abc123");
  });
});

// ── 8b: repo.pr.open input schema ────────────────────────────────────────────

describe("open_pr", () => {
  it("name is open_pr", () => {
    expect(repoPrOpen.name).toBe("open_pr");
  });

  it("parses a minimal valid input (owner, repo, title, head, base required)", () => {
    const parsed = repoPrOpen.input.parse({
      owner: "myorg",
      repo: "myrepo",
      title: "My PR",
      head: "feature/x",
      base: "main",
    });
    expect(parsed.owner).toBe("myorg");
    expect(parsed.title).toBe("My PR");
    expect(parsed.head).toBe("feature/x");
    expect(parsed.base).toBe("main");
    expect(parsed.body).toBeUndefined();
    expect(parsed.draft).toBeUndefined();
  });

  it("rejects input missing owner", () => {
    expect(() =>
      repoPrOpen.input.parse({
        repo: "myrepo",
        title: "My PR",
        head: "feature/x",
        base: "main",
      }),
    ).toThrow();
  });

  it("rejects input missing title", () => {
    expect(() =>
      repoPrOpen.input.parse({
        owner: "myorg",
        repo: "myrepo",
        head: "feature/x",
        base: "main",
      }),
    ).toThrow();
  });

  it("rejects input missing head", () => {
    expect(() =>
      repoPrOpen.input.parse({
        owner: "myorg",
        repo: "myrepo",
        title: "My PR",
        base: "main",
      }),
    ).toThrow();
  });

  it("rejects input missing base", () => {
    expect(() =>
      repoPrOpen.input.parse({
        owner: "myorg",
        repo: "myrepo",
        title: "My PR",
        head: "feature/x",
      }),
    ).toThrow();
  });

  it("parses a fully specified input", () => {
    const parsed = repoPrOpen.input.parse({
      owner: "myorg",
      repo: "myrepo",
      title: "Full PR",
      head: "feat/full",
      base: "main",
      body: "## Description",
      draft: true,
    });
    expect(parsed.body).toBe("## Description");
    expect(parsed.draft).toBe(true);
  });

  it("output schema includes number and htmlUrl", () => {
    const parsed = repoPrOpen.output.parse({
      number: 42,
      htmlUrl: "https://github.com/myorg/myrepo/pull/42",
    });
    expect(parsed.number).toBe(42);
    expect(parsed.htmlUrl).toBe("https://github.com/myorg/myrepo/pull/42");
  });
});
