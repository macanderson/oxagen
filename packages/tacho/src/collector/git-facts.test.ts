import { describe, expect, it } from "vitest";
import { digestBytes } from "../digest";
import type { Exec, ExecResult } from "../host/service";
import {
  parseNumstat,
  parsePorcelainZ,
  readGitFacts,
  readWorkingTreeChanges,
  resolveNumstatPath,
  worktreeReconciledBody,
} from "./git-facts";
import { MAX_OBSERVED_CHANGES, observedChangeSchema } from "../envelope";

/** A git that answers canned stdout, keyed by the sub-command it is given. */
function fakeGit(
  answers: Record<string, string | ExecResult>,
  calls: string[][] = [],
): Exec {
  return (command, args) => {
    calls.push([command, ...args]);
    if (command !== "git") return { status: 127, stdout: "", stderr: "" };
    for (const [key, value] of Object.entries(answers)) {
      if (args.join(" ").includes(key)) {
        return typeof value === "string"
          ? { status: 0, stdout: value, stderr: "" }
          : value;
      }
    }
    return { status: 1, stdout: "", stderr: "not matched" };
  };
}

const FAIL: ExecResult = { status: 128, stdout: "", stderr: "fatal" };

describe("readGitFacts", () => {
  it("reads head, branch, dirtiness and the digested remote", () => {
    const exec = fakeGit({
      "rev-parse --abbrev-ref HEAD": "feature/one\n",
      "rev-parse HEAD": "a".repeat(40) + "\n",
      "status --porcelain": " M src/a.ts\n",
      "remote get-url origin": "git@github.com:acme/widgets.git\n",
    });
    expect(readGitFacts(exec, "/repo")).toEqual({
      head_sha: "a".repeat(40),
      branch: "feature/one",
      dirty: true,
      remote_digest: digestBytes("git@github.com:acme/widgets.git"),
    });
  });

  it("never stores the remote url in the clear", () => {
    const url = "https://user:token@github.com/acme/widgets.git";
    const exec = fakeGit({
      "rev-parse --abbrev-ref HEAD": "main\n",
      "rev-parse HEAD": "b".repeat(40) + "\n",
      "status --porcelain": "",
      "remote get-url origin": `${url}\n`,
    });
    const facts = readGitFacts(exec, "/repo");
    expect(facts?.remote_digest).toBe(digestBytes(url));
    expect(JSON.stringify(facts)).not.toContain("token");
    expect(JSON.stringify(facts)).not.toContain("github.com");
  });

  it("reports a clean tree as not dirty", () => {
    const exec = fakeGit({
      "rev-parse --abbrev-ref HEAD": "main\n",
      "rev-parse HEAD": "c".repeat(40) + "\n",
      "status --porcelain": "\n",
      "remote get-url origin": "origin-url\n",
    });
    expect(readGitFacts(exec, "/repo")?.dirty).toBe(false);
  });

  it("omits the branch when the head is detached", () => {
    const exec = fakeGit({
      "rev-parse --abbrev-ref HEAD": "HEAD\n",
      "rev-parse HEAD": "d".repeat(40) + "\n",
      "status --porcelain": "",
    });
    const facts = readGitFacts(exec, "/repo");
    expect(facts?.head_sha).toBe("d".repeat(40));
    expect(facts?.branch).toBeUndefined();
    expect(facts?.remote_digest).toBeUndefined();
  });

  it("returns undefined for a directory that is not a repository", () => {
    expect(readGitFacts(fakeGit({ "rev-parse HEAD": FAIL }), "/tmp")).toBeUndefined();
  });

  it("returns undefined when git is not installed", () => {
    const exec: Exec = () => {
      throw new Error("spawn git ENOENT");
    };
    expect(readGitFacts(exec, "/repo")).toBeUndefined();
  });

  it("leaves dirtiness off when the status read fails", () => {
    const exec = fakeGit({
      "rev-parse --abbrev-ref HEAD": "main\n",
      "rev-parse HEAD": "e".repeat(40) + "\n",
      "status --porcelain": FAIL,
    });
    expect(readGitFacts(exec, "/repo")?.dirty).toBeUndefined();
  });

  it("reads without taking the index lock", () => {
    const calls: string[][] = [];
    readGitFacts(fakeGit({ "rev-parse HEAD": "f".repeat(40) }, calls), "/repo");
    expect(calls[0]).toContain("--no-optional-locks");
    expect(calls[0]?.slice(0, 3)).toEqual(["git", "-C", "/repo"]);
  });
});

describe("parsePorcelainZ", () => {
  it("separates entries on NUL and keeps the status code", () => {
    const parsed = parsePorcelainZ(" M src/a.ts\0?? new.txt\0 D gone.ts\0");
    expect(parsed).toEqual([
      { code: " M", path: "src/a.ts" },
      { code: "??", path: "new.txt" },
      { code: " D", path: "gone.ts" },
    ]);
  });

  it("consumes the original path that follows a rename", () => {
    const parsed = parsePorcelainZ("R  new.ts\0old.ts\0 M other.ts\0");
    expect(parsed).toEqual([
      { code: "R ", path: "new.ts" },
      { code: " M", path: "other.ts" },
    ]);
  });
});

describe("resolveNumstatPath", () => {
  it("resolves the arrow form to the new path", () => {
    expect(resolveNumstatPath("old.ts => new.ts")).toBe("new.ts");
  });

  it("resolves the braced form to the new path", () => {
    expect(resolveNumstatPath("src/{old => new}/a.ts")).toBe("src/new/a.ts");
  });

  it("collapses the empty half of a braced rename", () => {
    expect(resolveNumstatPath("src/{ => nested}/a.ts")).toBe("src/nested/a.ts");
  });

  it("leaves an ordinary path alone", () => {
    expect(resolveNumstatPath("src/a.ts")).toBe("src/a.ts");
  });
});

describe("parseNumstat", () => {
  it("reads counts and treats a binary file as zero on both", () => {
    const parsed = parseNumstat("12\t3\tsrc/a.ts\n-\t-\tlogo.png\n");
    expect(parsed.get("src/a.ts")).toEqual({ added: 12, removed: 3 });
    expect(parsed.get("logo.png")).toEqual({ added: 0, removed: 0 });
  });

  it("unquotes a path git escaped", () => {
    const parsed = parseNumstat('1\t0\t"a\\tb.ts"\n');
    expect(parsed.get("a\tb.ts")).toEqual({ added: 1, removed: 0 });
  });
});

describe("readWorkingTreeChanges", () => {
  const status =
    " M src/a.ts\0?? new.txt\0 D gone.ts\0R  renamed-new.ts\0renamed-old.ts\0";
  const numstat =
    "12\t3\tsrc/a.ts\n0\t9\tgone.ts\n2\t2\trenamed-old.ts => renamed-new.ts\n";

  it("reports one entry per changed path, with status and line counts", () => {
    const exec = fakeGit({
      "status --porcelain=v1 -z": status,
      "diff --numstat HEAD": numstat,
      "rev-parse --show-toplevel": "/repo\n",
    });
    expect(readWorkingTreeChanges(exec, "/repo/src")).toEqual([
      {
        path: "/repo/src/a.ts",
        repo_relative_path: "src/a.ts",
        status: "modified",
        lines_added: 12,
        lines_removed: 3,
      },
      {
        path: "/repo/new.txt",
        repo_relative_path: "new.txt",
        status: "added",
        lines_added: 0,
        lines_removed: 0,
      },
      {
        path: "/repo/gone.ts",
        repo_relative_path: "gone.ts",
        status: "deleted",
        lines_added: 0,
        lines_removed: 9,
      },
      {
        path: "/repo/renamed-new.ts",
        repo_relative_path: "renamed-new.ts",
        status: "renamed",
        lines_added: 2,
        lines_removed: 2,
      },
    ]);
  });

  it("keeps an untracked file even though no diff mentions it", () => {
    const exec = fakeGit({
      "status --porcelain=v1 -z": "?? build/out.js\0",
      "diff --numstat HEAD": "",
      "rev-parse --show-toplevel": "/repo\n",
    });
    const [only] = readWorkingTreeChanges(exec, "/repo");
    expect(only?.status).toBe("added");
    expect(only?.lines_added).toBe(0);
  });

  it("falls back to the unstaged diff in a repository with no commits", () => {
    const calls: string[][] = [];
    const exec = fakeGit(
      {
        "status --porcelain=v1 -z": " M src/a.ts\0",
        "diff --numstat HEAD": FAIL,
        "diff --numstat": "4\t1\tsrc/a.ts\n",
        "rev-parse --show-toplevel": "/repo\n",
      },
      calls,
    );
    expect(readWorkingTreeChanges(exec, "/repo")[0]?.lines_added).toBe(4);
    expect(calls.some((call) => call.includes("HEAD"))).toBe(true);
  });

  it("falls back to the repo-relative path when the root cannot be read", () => {
    const exec = fakeGit({
      "status --porcelain=v1 -z": " M src/a.ts\0",
      "diff --numstat HEAD": "",
      "rev-parse --show-toplevel": FAIL,
    });
    expect(readWorkingTreeChanges(exec, "/repo")[0]?.path).toBe("src/a.ts");
  });

  it("reports a binary file that changed, with zero on both counts", () => {
    const exec = fakeGit({
      "status --porcelain=v1 -z": " M logo.png\0",
      "diff --numstat HEAD": "-\t-\tlogo.png\n",
      "rev-parse --show-toplevel": "/repo\n",
    });
    expect(readWorkingTreeChanges(exec, "/repo")[0]).toMatchObject({
      status: "modified",
      lines_added: 0,
      lines_removed: 0,
    });
  });

  it("returns nothing for a directory that is not a repository", () => {
    expect(readWorkingTreeChanges(fakeGit({}), "/tmp")).toEqual([]);
  });

  it("returns nothing when git is not installed", () => {
    const exec: Exec = () => {
      throw new Error("spawn git ENOENT");
    };
    expect(readWorkingTreeChanges(exec, "/repo")).toEqual([]);
  });

  it("returns nothing for a clean tree", () => {
    const exec = fakeGit({ "status --porcelain=v1 -z": "" });
    expect(readWorkingTreeChanges(exec, "/repo")).toEqual([]);
  });
});

describe("worktreeReconciledBody", () => {
  const change = (name: string) => ({
    path: `/repo/${name}`,
    repo_relative_path: name,
    status: "modified" as const,
    lines_added: 1,
    lines_removed: 0,
  });

  it("carries the whole list when it fits, sorted by path", () => {
    const body = worktreeReconciledBody([change("b.ts"), change("a.ts")]);
    expect(body["observed_changes_total"]).toBe(2);
    expect(body["observed_changes_truncated"]).toBe(false);
    expect(
      (body["observed_changes"] as { repo_relative_path: string }[]).map(
        (row) => row.repo_relative_path,
      ),
    ).toEqual(["a.ts", "b.ts"]);
  });

  it("records the cut rather than making it silently", () => {
    const changes = Array.from({ length: MAX_OBSERVED_CHANGES + 10 }, (_, i) =>
      change(`f${String(i).padStart(4, "0")}.ts`),
    );
    const body = worktreeReconciledBody(changes);
    expect(body["observed_changes"]).toHaveLength(MAX_OBSERVED_CHANGES);
    expect(body["observed_changes_total"]).toBe(MAX_OBSERVED_CHANGES + 10);
    expect(body["observed_changes_truncated"]).toBe(true);
  });

  it("produces rows the envelope schema accepts", () => {
    const body = worktreeReconciledBody([change("a.ts")]);
    for (const row of body["observed_changes"] as unknown[]) {
      expect(observedChangeSchema.parse(row)).toBeTruthy();
    }
  });

  it("says nothing changed for a clean tree", () => {
    const body = worktreeReconciledBody([]);
    expect(body["observed_changes"]).toEqual([]);
    expect(body["observed_changes_total"]).toBe(0);
    expect(body["observed_changes_truncated"]).toBe(false);
  });
});
