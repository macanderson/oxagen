import { describe, expect, it } from "vitest";
import { digestBytes } from "../digest";
import type { ExecAsync, ExecResult } from "../host/service";
import {
  canonicalRemote,
  MAX_UNTRACKED_LINE_COUNTS,
  parseNumstat,
  parsePorcelainZ,
  readGitFacts,
  readWorkingTreePatch,
  MAX_PATCH_BYTES,
  readWorkingTreeChanges,
  resolveNumstatPath,
  worktreeReconciledBody,
} from "./git-facts";
import { MAX_OBSERVED_CHANGES, observedChangeSchema } from "../envelope";

/**
 * A git that answers canned stdout, keyed by the sub-command it is given.
 *
 * It resolves on a later tick on purpose. A fake that returned a settled
 * promise would pass whether or not the reader awaited it, so every
 * assertion below would hold against a reader that still blocked. Resolving
 * after a macrotask means an unawaited read reads as undefined.
 */
function fakeGit(
  answers: Record<string, string | ExecResult>,
  calls: string[][] = [],
): ExecAsync {
  return async (command, args) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
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
  it("reads head, branch, dirtiness and the digested remote", async () => {
    const exec = fakeGit({
      "rev-parse --abbrev-ref HEAD": "feature/one\n",
      "rev-parse HEAD": "a".repeat(40) + "\n",
      "status --porcelain": " M src/a.ts\n",
      "remote get-url origin": "git@github.com:acme/widgets.git\n",
    });
    expect(await readGitFacts(exec, "/repo")).toEqual({
      head_sha: "a".repeat(40),
      branch: "feature/one",
      dirty: true,
      // Canonical, so the ssh and https spellings of one repository agree.
      remote_digest: digestBytes("github.com/acme/widgets"),
    });
  });

  it("never stores the remote url in the clear", async () => {
    const url = "https://user:token@github.com/acme/widgets.git";
    const exec = fakeGit({
      "rev-parse --abbrev-ref HEAD": "main\n",
      "rev-parse HEAD": "b".repeat(40) + "\n",
      "status --porcelain": "",
      "remote get-url origin": `${url}\n`,
    });
    const facts = await readGitFacts(exec, "/repo");
    // The digest is of the canonical repository, not of the URL as this
    // machine spells it. Hashing the raw URL made the identity depend on
    // the credential in its userinfo, so the same repository digested
    // differently on two machines and after every token rotation.
    expect(facts?.remote_digest).toBe(digestBytes("github.com/acme/widgets"));
    expect(facts?.remote_digest).not.toBe(digestBytes(url));
    expect(JSON.stringify(facts)).not.toContain("token");
    expect(JSON.stringify(facts)).not.toContain("github.com");

    // The same repository over ssh, with no credential at all, is the same
    // identity. That is the property the digest exists for.
    const viaSsh = await readGitFacts(
      fakeGit({
        "rev-parse --abbrev-ref HEAD": "main\n",
        "rev-parse HEAD": "b".repeat(40) + "\n",
        "status --porcelain": "",
        "remote get-url origin": "git@github.com:acme/widgets.git\n",
      }),
      "/repo",
    );
    expect(viaSsh?.remote_digest).toBe(facts?.remote_digest);
  });

  it("reports a clean tree as not dirty", async () => {
    const exec = fakeGit({
      "rev-parse --abbrev-ref HEAD": "main\n",
      "rev-parse HEAD": "c".repeat(40) + "\n",
      "status --porcelain": "\n",
      "remote get-url origin": "origin-url\n",
    });
    expect((await readGitFacts(exec, "/repo"))?.dirty).toBe(false);
  });

  it("omits the branch when the head is detached", async () => {
    const exec = fakeGit({
      "rev-parse --abbrev-ref HEAD": "HEAD\n",
      "rev-parse HEAD": "d".repeat(40) + "\n",
      "status --porcelain": "",
    });
    const facts = await readGitFacts(exec, "/repo");
    expect(facts?.head_sha).toBe("d".repeat(40));
    expect(facts?.branch).toBeUndefined();
    expect(facts?.remote_digest).toBeUndefined();
  });

  it("returns undefined for a directory that is not a repository", async () => {
    expect(
      await readGitFacts(fakeGit({ "rev-parse HEAD": FAIL }), "/tmp"),
    ).toBeUndefined();
  });

  it("returns undefined when git is not installed", async () => {
    const exec: ExecAsync = () => {
      throw new Error("spawn git ENOENT");
    };
    expect(await readGitFacts(exec, "/repo")).toBeUndefined();
  });

  it("leaves dirtiness off when the status read fails", async () => {
    const exec = fakeGit({
      "rev-parse --abbrev-ref HEAD": "main\n",
      "rev-parse HEAD": "e".repeat(40) + "\n",
      "status --porcelain": FAIL,
    });
    expect((await readGitFacts(exec, "/repo"))?.dirty).toBeUndefined();
  });

  it("leaves the event loop free while a read is in flight", async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    const slow: ExecAsync = (_command, args) =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              status: 0,
              stdout:
                args.at(-2) === "rev-parse" && args.at(-1) === "HEAD"
                  ? "a".repeat(40)
                  : "",
              stderr: "",
            }),
          25,
        ),
      );
    const facts = await readGitFacts(slow, "/repo");
    clearInterval(timer);
    expect(facts?.head_sha).toBe("a".repeat(40));
    // A synchronous probe would have stopped the timer from ever firing,
    // which is the daemon failing to answer a hook.
    expect(ticks).toBeGreaterThan(0);
  });

  it("issues the reads that do not gate each other together", async () => {
    let inFlight = 0;
    let peak = 0;
    const exec: ExecAsync = async (_command, args) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return {
        status: 0,
        stdout:
          args.at(-2) === "rev-parse" && args.at(-1) === "HEAD"
            ? "a".repeat(40)
            : "",
        stderr: "",
      };
    };
    await readGitFacts(exec, "/repo");
    // `HEAD` alone, then branch, status and remote at once.
    expect(peak).toBe(3);
  });

  it("reads without taking the index lock", async () => {
    const calls: string[][] = [];
    await readGitFacts(
      fakeGit({ "rev-parse HEAD": "f".repeat(40) }, calls),
      "/repo",
    );
    expect(calls[0]).toContain("--no-optional-locks");
    expect(calls[0]?.slice(0, 3)).toEqual(["git", "-C", "/repo"]);
  });
});

describe("parsePorcelainZ", () => {
  it("separates entries on NUL and keeps the status code", async () => {
    const parsed = parsePorcelainZ(" M src/a.ts\0?? new.txt\0 D gone.ts\0");
    expect(parsed).toEqual([
      { code: " M", path: "src/a.ts" },
      { code: "??", path: "new.txt" },
      { code: " D", path: "gone.ts" },
    ]);
  });

  it("consumes the original path that follows a rename", async () => {
    const parsed = parsePorcelainZ("R  new.ts\0old.ts\0 M other.ts\0");
    expect(parsed).toEqual([
      { code: "R ", path: "new.ts" },
      { code: " M", path: "other.ts" },
    ]);
  });
});

describe("resolveNumstatPath", () => {
  it("resolves the arrow form to the new path", async () => {
    expect(resolveNumstatPath("old.ts => new.ts")).toBe("new.ts");
  });

  it("resolves the braced form to the new path", async () => {
    expect(resolveNumstatPath("src/{old => new}/a.ts")).toBe("src/new/a.ts");
  });

  it("collapses the empty half of a braced rename", async () => {
    expect(resolveNumstatPath("src/{ => nested}/a.ts")).toBe("src/nested/a.ts");
  });

  it("leaves an ordinary path alone", async () => {
    expect(resolveNumstatPath("src/a.ts")).toBe("src/a.ts");
  });
});

describe("parseNumstat", () => {
  it("reads counts and treats a binary file as zero on both", async () => {
    const parsed = parseNumstat("12\t3\tsrc/a.ts\n-\t-\tlogo.png\n");
    expect(parsed.get("src/a.ts")).toEqual({ added: 12, removed: 3 });
    expect(parsed.get("logo.png")).toEqual({ added: 0, removed: 0 });
  });

  it("unquotes a path git escaped", async () => {
    const parsed = parseNumstat('1\t0\t"a\\tb.ts"\n');
    expect(parsed.get("a\tb.ts")).toEqual({ added: 1, removed: 0 });
  });
});

describe("readWorkingTreeChanges", () => {
  const status =
    " M src/a.ts\0?? new.txt\0 D gone.ts\0R  renamed-new.ts\0renamed-old.ts\0";
  const numstat =
    "12\t3\tsrc/a.ts\n0\t9\tgone.ts\n2\t2\trenamed-old.ts => renamed-new.ts\n";

  it("reports work the session committed, with a clean worktree", async () => {
    // The loss this closes: an agent edits files through a shell command or a
    // formatter and commits them before the end-of-turn `Stop`. `git status`
    // is then clean and `HEAD` has moved, so comparing the worktree with
    // `HEAD` answers "nothing changed" and the run records a commit with none
    // of its files. Measuring from the commit the session started on asks the
    // question the record is actually for.
    const calls: string[][] = [];
    const exec = fakeGit(
      {
        "status --porcelain=v1 -z": "",
        "diff --name-status -z base-sha": "M\0src/a.ts\0A\0src/b.ts\0",
        "diff --numstat base-sha": "12\t3\tsrc/a.ts\n40\t0\tsrc/b.ts\n",
        "rev-parse --show-toplevel": "/repo\n",
      },
      calls,
    );
    expect(await readWorkingTreeChanges(exec, "/repo/src", "base-sha")).toEqual(
      [
        {
          path: "/repo/src/a.ts",
          repo_relative_path: "src/a.ts",
          status: "modified",
          lines_added: 12,
          lines_removed: 3,
        },
        {
          path: "/repo/src/b.ts",
          repo_relative_path: "src/b.ts",
          status: "added",
          lines_added: 40,
          lines_removed: 0,
        },
      ],
    );
    // Measured from the baseline, never from the moved HEAD.
    expect(calls.some((c) => c.includes("HEAD"))).toBe(false);
  });

  it("falls back to HEAD when the baseline is no longer in the graph", async () => {
    // A rebase, an amend or a reset can take the baseline out of the graph.
    // Answering from the empty tree instead would report every file in the
    // repository as added by this run, so the read falls back to the question
    // it can still answer.
    const exec = fakeGit({
      "status --porcelain=v1 -z": " M src/a.ts\0",
      "diff --name-status -z gone-sha": {
        status: 128,
        stdout: "",
        stderr: "bad object",
      },
      "diff --numstat HEAD": "12\t3\tsrc/a.ts\n",
      "rev-parse --show-toplevel": "/repo\n",
    });
    expect(await readWorkingTreeChanges(exec, "/repo/src", "gone-sha")).toEqual(
      [
        {
          path: "/repo/src/a.ts",
          repo_relative_path: "src/a.ts",
          status: "modified",
          lines_added: 12,
          lines_removed: 3,
        },
      ],
    );
  });

  it("keeps untracked files, which are in no diff", async () => {
    // The untracked half still comes from `status`: a file git does not track
    // appears in no diff against any commit, baseline included.
    const exec = fakeGit({
      "status --porcelain=v1 -z": "?? new.txt\0",
      "diff --name-status -z base-sha": "M\0src/a.ts\0",
      "diff --numstat base-sha": "12\t3\tsrc/a.ts\n",
      "rev-parse --show-toplevel": "/repo\n",
      "hash-object": "",
    });
    const changes = await readWorkingTreeChanges(exec, "/repo/src", "base-sha");
    expect(changes?.map((c) => c.repo_relative_path).sort()).toEqual([
      "new.txt",
      "src/a.ts",
    ]);
  });

  it("reports one entry per changed path, with status and line counts", async () => {
    const exec = fakeGit({
      "status --porcelain=v1 -z": status,
      "diff --numstat HEAD": numstat,
      "rev-parse --show-toplevel": "/repo\n",
    });
    expect(await readWorkingTreeChanges(exec, "/repo/src")).toEqual([
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

  it("measures an untracked file that no diff mentions", async () => {
    const calls: string[][] = [];
    const exec = fakeGit(
      {
        "status --porcelain=v1 -z": "?? new.txt\0",
        "diff --numstat HEAD": "",
        "rev-parse --show-toplevel": "/repo\n",
        // `--no-index` exits 1 to say the two inputs differ, which is the
        // answer, not a failure.
        "--no-index": {
          status: 1,
          stdout: "412\t0\t/dev/null => /repo/new.txt\n",
          stderr: "",
        },
      },
      calls,
    );
    const [only] = (await readWorkingTreeChanges(exec, "/repo")) ?? [];
    expect(only?.status).toBe("added");
    // The count that used to be recorded as zero, which ingest then kept as
    // the run's observed line count.
    expect(only?.lines_added).toBe(412);
    expect(only?.lines_removed).toBe(0);
    expect(calls.filter((call) => call.includes("--no-index"))).toHaveLength(1);
  });

  it("leaves an untracked count at zero when the probe cannot answer", async () => {
    const exec = fakeGit({
      "status --porcelain=v1 -z": "?? new.txt\0",
      "diff --numstat HEAD": "",
      "rev-parse --show-toplevel": "/repo\n",
      "--no-index": FAIL,
    });
    expect(
      ((await readWorkingTreeChanges(exec, "/repo")) ?? [])[0]?.lines_added,
    ).toBe(0);
  });

  it("does not probe a tracked path the numstat left out", async () => {
    const calls: string[][] = [];
    const exec = fakeGit(
      {
        // A mode change: git reports the path and no line count for it.
        "status --porcelain=v1 -z": " M src/a.ts\0",
        "diff --numstat HEAD": "",
        "rev-parse --show-toplevel": "/repo\n",
      },
      calls,
    );
    const [only] = (await readWorkingTreeChanges(exec, "/repo")) ?? [];
    expect(only?.status).toBe("modified");
    // Diffing a tracked file against nothing would count all of it as added.
    expect(calls.some((call) => call.includes("--no-index"))).toBe(false);
    expect(only?.lines_added).toBe(0);
  });

  it("does not probe an untracked directory entry", async () => {
    const calls: string[][] = [];
    const exec = fakeGit(
      {
        "status --porcelain=v1 -z": "?? build/\0",
        "diff --numstat HEAD": "",
        "rev-parse --show-toplevel": "/repo\n",
      },
      calls,
    );
    const [only] = (await readWorkingTreeChanges(exec, "/repo")) ?? [];
    // A directory entry names a subtree, and `--no-index` has no line count
    // to give for one.
    expect(only?.repo_relative_path).toBe("build/");
    expect(calls.some((call) => call.includes("--no-index"))).toBe(false);
  });

  it("probes no more untracked files than the bound allows", async () => {
    const count = MAX_UNTRACKED_LINE_COUNTS + 20;
    const paths = Array.from({ length: count }, (_value, index) =>
      String(index).padStart(4, "0"),
    );
    const calls: string[][] = [];
    const exec = fakeGit(
      {
        "status --porcelain=v1 -z": paths
          .map((name) => `?? ${name}.txt\0`)
          .join(""),
        "diff --numstat HEAD": "",
        "rev-parse --show-toplevel": "/repo\n",
        "--no-index": { status: 1, stdout: "1\t0\tx\n", stderr: "" },
      },
      calls,
    );
    const changes = await readWorkingTreeChanges(exec, "/repo");
    expect(changes).toHaveLength(count);
    expect(calls.filter((call) => call.includes("--no-index"))).toHaveLength(
      MAX_UNTRACKED_LINE_COUNTS,
    );
    // Path order decides which files are measured, so the same ones are
    // measured on every pass.
    const probed = calls
      .filter((call) => call.includes("--no-index"))
      .map((call) => call[call.length - 1]);
    expect(probed).toContain("/repo/0000.txt");
    expect(probed).not.toContain(`/repo/${paths[count - 1]}.txt`);
  });

  it("skips the untracked probe when the repository root is unknown", async () => {
    const calls: string[][] = [];
    const exec = fakeGit(
      {
        "status --porcelain=v1 -z": "?? new.txt\0",
        "diff --numstat HEAD": "",
        "rev-parse --show-toplevel": FAIL,
      },
      calls,
    );
    await readWorkingTreeChanges(exec, "/repo");
    expect(calls.some((call) => call.includes("--no-index"))).toBe(false);
  });

  it("diffs against the empty tree in a repository with no commits", async () => {
    const calls: string[][] = [];
    const exec = fakeGit(
      {
        "status --porcelain=v1 -z": " M src/a.ts\0",
        "diff --numstat HEAD": FAIL,
        "diff --numstat 4b825dc642cb6eb9a060e54bf8d69288fbee4904":
          "4\t1\tsrc/a.ts\n",
        "rev-parse --show-toplevel": "/repo\n",
      },
      calls,
    );
    expect(
      ((await readWorkingTreeChanges(exec, "/repo")) ?? [])[0]?.lines_added,
    ).toBe(4);
    expect(calls.some((call) => call.includes("HEAD"))).toBe(true);
  });

  it("measures a partly staged initial file against nothing, not twice", async () => {
    // Staged at three lines, then one line replaced and one added. A staged
    // diff says 3/0 and an unstaged diff says 2/1 for the same path, so
    // reading both and keying by path kept whichever came last. The file's
    // real distance from an empty repository is 4/0, and one diff naming
    // the empty tree is what asks for it.
    const exec = fakeGit({
      "status --porcelain=v1 -z": "A  src/a.ts\0",
      "diff --numstat HEAD": FAIL,
      "diff --numstat 4b825dc642cb6eb9a060e54bf8d69288fbee4904":
        "4\t0\tsrc/a.ts\n",
      "diff --numstat --cached": "3\t0\tsrc/a.ts\n",
      "diff --numstat": "2\t1\tsrc/a.ts\n",
      "rev-parse --show-toplevel": "/repo\n",
    });
    const [only] = (await readWorkingTreeChanges(exec, "/repo")) ?? [];
    expect(only?.lines_added).toBe(4);
    expect(only?.lines_removed).toBe(0);
  });

  it("asks git to name every file inside an untracked directory", async () => {
    // Without `all`, git collapses a new directory into a single `?? dir/`
    // entry, and the run records one synthetic path with no line counts
    // instead of the files the agent actually created.
    const calls: string[][] = [];
    const exec = fakeGit(
      {
        "status --porcelain=v1 -z": "?? new/a.ts\0?? new/b.ts\0",
        "diff --numstat HEAD": "",
        "rev-parse --show-toplevel": "/repo\n",
        "--no-index": {
          status: 1,
          stdout: "7\t0\t/dev/null => /repo/new/a.ts\n",
          stderr: "",
        },
      },
      calls,
    );
    const changes = (await readWorkingTreeChanges(exec, "/repo")) ?? [];
    expect(changes.map((change) => change.repo_relative_path)).toEqual([
      "new/a.ts",
      "new/b.ts",
    ]);
    const statusCall = calls.find((call) => call.includes("--porcelain=v1"));
    expect(statusCall).toContain("--untracked-files=all");
  });

  it("falls back to the repo-relative path when the root cannot be read", async () => {
    const exec = fakeGit({
      "status --porcelain=v1 -z": " M src/a.ts\0",
      "diff --numstat HEAD": "",
      "rev-parse --show-toplevel": FAIL,
    });
    expect(((await readWorkingTreeChanges(exec, "/repo")) ?? [])[0]?.path).toBe(
      "src/a.ts",
    );
  });

  it("reports a binary file that changed, with zero on both counts", async () => {
    const exec = fakeGit({
      "status --porcelain=v1 -z": " M logo.png\0",
      "diff --numstat HEAD": "-\t-\tlogo.png\n",
      "rev-parse --show-toplevel": "/repo\n",
    });
    expect(
      ((await readWorkingTreeChanges(exec, "/repo")) ?? [])[0],
    ).toMatchObject({
      status: "modified",
      lines_added: 0,
      lines_removed: 0,
    });
  });

  it("says unavailable, not clean, for a directory that is not a repository", async () => {
    // Undefined and an empty list are different answers. The caller seals a
    // reconciliation frame from an empty list, and a frame saying the
    // worktree was clean is a claim nobody observed.
    expect(await readWorkingTreeChanges(fakeGit({}), "/tmp")).toBeUndefined();
  });

  it("says unavailable when git is not installed", async () => {
    const exec: ExecAsync = () => {
      throw new Error("spawn git ENOENT");
    };
    expect(await readWorkingTreeChanges(exec, "/repo")).toBeUndefined();
  });

  it("says unavailable when the status read itself fails", async () => {
    const exec: ExecAsync = async (_command, args) =>
      args.includes("status")
        ? { status: 1, stdout: "", stderr: "timed out" }
        : { status: 0, stdout: "", stderr: "" };
    expect(await readWorkingTreeChanges(exec, "/repo")).toBeUndefined();
  });

  it("returns an empty list for a clean tree, which is an observation", async () => {
    const exec = fakeGit({ "status --porcelain=v1 -z": "" });
    expect(await readWorkingTreeChanges(exec, "/repo")).toEqual([]);
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

  it("carries the whole list when it fits, sorted by path", async () => {
    const body = worktreeReconciledBody([change("b.ts"), change("a.ts")]);
    expect(body["observed_changes_total"]).toBe(2);
    expect(body["observed_changes_truncated"]).toBe(false);
    expect(
      (body["observed_changes"] as { repo_relative_path: string }[]).map(
        (row) => row.repo_relative_path,
      ),
    ).toEqual(["a.ts", "b.ts"]);
  });

  it("records the cut rather than making it silently", async () => {
    const changes = Array.from({ length: MAX_OBSERVED_CHANGES + 10 }, (_, i) =>
      change(`f${String(i).padStart(4, "0")}.ts`),
    );
    const body = worktreeReconciledBody(changes);
    expect(body["observed_changes"]).toHaveLength(MAX_OBSERVED_CHANGES);
    expect(body["observed_changes_total"]).toBe(MAX_OBSERVED_CHANGES + 10);
    expect(body["observed_changes_truncated"]).toBe(true);
  });

  it("produces rows the envelope schema accepts", async () => {
    const body = worktreeReconciledBody([change("a.ts")]);
    for (const row of body["observed_changes"] as unknown[]) {
      expect(observedChangeSchema.parse(row)).toBeTruthy();
    }
  });

  it("says nothing changed for a clean tree", async () => {
    const body = worktreeReconciledBody([]);
    expect(body["observed_changes"]).toEqual([]);
    expect(body["observed_changes_total"]).toBe(0);
    expect(body["observed_changes_truncated"]).toBe(false);
  });
});

describe("canonicalRemote", () => {
  // The digest exists to tell repositories apart without naming them, so it
  // has to depend on the repository and nothing else.
  const forms = [
    "https://github.com/acme/repo.git",
    "https://github.com/acme/repo",
    "https://user:ghp_secret@github.com/acme/repo.git",
    "https://x-access-token:ghs_other@github.com/acme/repo.git",
    "git@github.com:acme/repo.git",
    "ssh://git@github.com/acme/repo.git",
    "https://GitHub.com/acme/repo.git",
    "https://github.com/acme/repo.git/",
  ];

  it("gives every form of one repository the same identity", () => {
    const identities = new Set(forms.map(canonicalRemote));
    expect(identities).toEqual(new Set(["github.com/acme/repo"]));
  });

  it("keeps different repositories apart", () => {
    expect(canonicalRemote("https://github.com/acme/other.git")).not.toBe(
      canonicalRemote("https://github.com/acme/repo.git"),
    );
    // A repository name is case sensitive on most forges, so the path is
    // not folded even though the host is.
    expect(canonicalRemote("https://github.com/acme/Repo.git")).not.toBe(
      canonicalRemote("https://github.com/acme/repo.git"),
    );
  });

  it("carries no credential into the identity", () => {
    for (const secret of ["ghp_secret", "ghs_other", "user", "x-access-token"])
      for (const form of forms)
        expect(canonicalRemote(form)).not.toContain(secret);
  });
});

describe("run discovery context and retained patch", () => {
  it("captures the repository root even before its first commit", async () => {
    const facts = await readGitFacts(
      fakeGit({ "rev-parse --show-toplevel": "/work/project\n" }),
      "/work/project/src",
    );
    expect(facts).toEqual({ project_dir: "/work/project" });
  });
  it("captures a bounded tracked snapshot against the observed baseline", async () => {
    const calls: string[][] = [];
    const patch = await readWorkingTreePatch(
      fakeGit({ diff: "x".repeat(MAX_PATCH_BYTES + 1) }, calls),
      "/repo",
      "a".repeat(40),
    );
    expect(patch).toMatchObject({
      truncated: true,
      baseSha: "a".repeat(40),
      scope: "tracked_worktree",
    });
    expect(Buffer.byteLength(patch!.patch)).toBe(MAX_PATCH_BYTES);
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        "--no-ext-diff",
        "--no-textconv",
        "a".repeat(40),
      ]),
    );
  });
  it("distinguishes a clean patch from a failed or unavailable baseline", async () => {
    expect(
      await readWorkingTreePatch(
        fakeGit({ diff: "" }),
        "/repo",
        "a".repeat(40),
      ),
    ).toMatchObject({ patch: "", truncated: false });
    expect(
      await readWorkingTreePatch(fakeGit({}), "/repo", "a".repeat(40)),
    ).toBeUndefined();
    const calls: string[][] = [];
    expect(
      await readWorkingTreePatch(fakeGit({}, calls), "/repo"),
    ).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
