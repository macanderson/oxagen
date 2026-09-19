import { describe, expect, it, vi } from "vitest";
import {
  classifyProbeFailure,
  commitPresent,
  defaultBranch,
  fetchBranch,
  GitCommandError,
  isAncestor,
  gitOrNull,
  parseNameStatus,
  parsePorcelain,
  indexBlobs,
  pathsInTree,
  treeBlobs,
  workingBlobs,
  type GitContext,
  type GitRunner,
} from "./git";

/** A runner over a table keyed by the joined argv, with a fallthrough. */
function runner(table: Record<string, string | Error>): GitRunner {
  return async (args) => {
    const key = args.join(" ");
    const hit = table[key];
    if (hit === undefined) throw new Error(`unexpected git ${key}`);
    if (hit instanceof Error) throw hit;
    return hit;
  };
}

function ctx(run: GitRunner): GitContext {
  return { cwd: "/repo", run, timeoutMs: 1000 };
}

describe("parseNameStatus", () => {
  it("reads added, modified and removed", () => {
    const raw =
      "A\0.oxagen/rules/a.toml\0M\0.oxagen/rules/b.toml\0D\0.oxagen/rules/c.toml\0";
    expect(parseNameStatus(raw)).toEqual([
      { status: "added", path: ".oxagen/rules/a.toml" },
      { status: "modified", path: ".oxagen/rules/b.toml" },
      { status: "removed", path: ".oxagen/rules/c.toml" },
    ]);
  });

  it("is empty for empty output", () => {
    expect(parseNameStatus("")).toEqual([]);
    expect(parseNameStatus("\0")).toEqual([]);
  });

  // A lineage id becomes a file stem, so a path can hold anything a filename
  // can, including a newline. The NUL form is the only one that survives it.
  it("keeps a path containing a newline in one piece", () => {
    const raw = "A\0.oxagen/rules/we\nird.toml\0";
    expect(parseNameStatus(raw)).toEqual([
      { status: "added", path: ".oxagen/rules/we\nird.toml" },
    ]);
  });

  it("takes the destination of a rename and skips the source", () => {
    const raw = "R100\0.oxagen/rules/old.toml\0.oxagen/rules/new.toml\0";
    expect(parseNameStatus(raw)).toEqual([
      { status: "renamed", path: ".oxagen/rules/new.toml" },
    ]);
  });

  it("calls a type change a modification and an unknown letter other", () => {
    expect(parseNameStatus("T\0a\0")).toEqual([
      { status: "modified", path: "a" },
    ]);
    expect(parseNameStatus("X\0a\0")).toEqual([{ status: "other", path: "a" }]);
  });
});

describe("parsePorcelain", () => {
  it("reads modified, staged and untracked paths", () => {
    const raw =
      " M .oxagen/rules/a.toml\0M  .oxagen/rules/b.toml\0?? .oxagen/rules/c.toml\0";
    expect(parsePorcelain(raw)).toEqual([
      ".oxagen/rules/a.toml",
      ".oxagen/rules/b.toml",
      ".oxagen/rules/c.toml",
    ]);
  });

  it("skips the original path of a rename", () => {
    const raw = "R  .oxagen/rules/new.toml\0.oxagen/rules/old.toml\0";
    expect(parsePorcelain(raw)).toEqual([".oxagen/rules/new.toml"]);
  });

  // `!!` is an ignored file. It is dirt for the question this answers: a
  // sync's `restore --worktree` would replace it all the same.
  it("counts an ignored file as a dirty path", () => {
    expect(parsePorcelain("!! .oxagen/rules/local.toml\0")).toEqual([
      ".oxagen/rules/local.toml",
    ]);
  });

  it("is empty for a clean tree", () => {
    expect(parsePorcelain("")).toEqual([]);
  });
});

describe("treeBlobs, indexBlobs, workingBlobs and pathsInTree", () => {
  it("reads production's blobs, keeping only what the tree holds", async () => {
    const run = runner({
      "ls-tree -r -z deadbeef -- .oxagen/rules/a.toml .oxagen/rules/b.toml .oxagen/rules/c.toml":
        [
          "100644 blob cccc\t.oxagen/rules/c.toml",
          "100644 blob aaaa\t.oxagen/rules/a.toml",
          "040000 tree dddd\t.oxagen/rules/d",
          "",
        ].join("\0"),
    });
    const paths = [
      ".oxagen/rules/a.toml",
      ".oxagen/rules/b.toml",
      ".oxagen/rules/c.toml",
    ];
    await expect(treeBlobs(ctx(run), "deadbeef", paths)).resolves.toEqual(
      new Map([
        [".oxagen/rules/c.toml", "cccc"],
        [".oxagen/rules/a.toml", "aaaa"],
      ]),
    );
    await expect(pathsInTree(ctx(run), "deadbeef", paths)).resolves.toEqual([
      ".oxagen/rules/a.toml",
      ".oxagen/rules/c.toml",
    ]);
  });

  it("reads the index's blobs", async () => {
    const run = runner({
      "ls-files -s -z -- .oxagen/rules/a.toml .oxagen/rules/b.toml":
        "100644 aaaa 0\t.oxagen/rules/a.toml\0",
    });
    await expect(
      indexBlobs(ctx(run), [".oxagen/rules/a.toml", ".oxagen/rules/b.toml"]),
    ).resolves.toEqual(new Map([[".oxagen/rules/a.toml", "aaaa"]]));
  });

  it("reads the working copy's blobs in the order asked", async () => {
    const run = runner({
      "hash-object -- .oxagen/rules/a.toml .oxagen/rules/b.toml":
        "aaaa\nbbbb\n",
    });
    await expect(
      workingBlobs(ctx(run), [".oxagen/rules/a.toml", ".oxagen/rules/b.toml"]),
    ).resolves.toEqual(
      new Map([
        [".oxagen/rules/a.toml", "aaaa"],
        [".oxagen/rules/b.toml", "bbbb"],
      ]),
    );
  });

  it("asks nothing for an empty list", async () => {
    const run = vi.fn<GitRunner>();
    await expect(pathsInTree(ctx(run), "deadbeef", [])).resolves.toEqual([]);
    await expect(indexBlobs(ctx(run), [])).resolves.toEqual(new Map());
    await expect(workingBlobs(ctx(run), [])).resolves.toEqual(new Map());
    expect(run).not.toHaveBeenCalled();
  });

  it("lets a failing ls-tree reject, so the caller can report unknown", async () => {
    const run = runner({
      "ls-tree -r -z deadbeef -- .oxagen/rules/a.toml": new Error("bad object"),
    });
    await expect(
      pathsInTree(ctx(run), "deadbeef", [".oxagen/rules/a.toml"]),
    ).rejects.toThrow("bad object");
  });
});

describe("gitOrNull", () => {
  it("returns null instead of throwing", async () => {
    const result = await gitOrNull(
      ctx(runner({ "rev-parse x": new Error("bad") })),
      "rev-parse",
      "x",
    );
    expect(result).toBeNull();
  });

  it("trims the output", async () => {
    const result = await gitOrNull(
      ctx(runner({ "a b": "  out \n" })),
      "a",
      "b",
    );
    expect(result).toBe("out");
  });
});

describe("defaultBranch", () => {
  const SYMREF = "symbolic-ref --quiet --short refs/remotes/origin/HEAD";

  const SETHEAD = "remote set-head origin --auto";

  it("reads the cached remote HEAD, refreshing it first when online", async () => {
    const run = vi.fn(runner({ [SETHEAD]: "", [SYMREF]: "origin/main" }));
    expect(
      await defaultBranch(ctx(run), "origin", { allowNetwork: true }),
    ).toBe("main");
    expect(run).toHaveBeenCalledWith(
      ["remote", "set-head", "origin", "--auto"],
      expect.anything(),
    );
  });

  // `refs/remotes/<remote>/HEAD` is written by clone and never again, so a
  // renamed default branch leaves it pointing at a branch that is no longer
  // production — and every steering change on the new one is invisible.
  it("follows a renamed default branch rather than the stale cache", async () => {
    let head = "origin/main";
    const run: GitRunner = async (args) => {
      const key = args.join(" ");
      if (key === SETHEAD) {
        head = "origin/production";
        return "";
      }
      if (key === SYMREF) return head;
      throw new Error(`unexpected git ${key}`);
    };
    expect(
      await defaultBranch(ctx(run), "origin", { allowNetwork: true }),
    ).toBe("production");
  });

  it("uses the cache untouched when the network is not allowed", async () => {
    const run = vi.fn(runner({ [SYMREF]: "origin/main" }));
    expect(
      await defaultBranch(ctx(run), "origin", { allowNetwork: false }),
    ).toBe("main");
    expect(run).toHaveBeenCalledTimes(1);
  });

  // Offline, or a remote that will not answer, is the case the cache exists
  // to cover: the refresh is best-effort and never fails the lookup.
  it("still answers from the cache when the refresh fails", async () => {
    const run = runner({
      [SETHEAD]: new Error("offline"),
      [SYMREF]: "origin/main",
    });
    expect(
      await defaultBranch(ctx(run), "origin", { allowNetwork: true }),
    ).toBe("main");
  });

  it("keeps a branch name containing a slash intact", async () => {
    const run = runner({ [SETHEAD]: "", [SYMREF]: "origin/release/2026" });
    expect(
      await defaultBranch(ctx(run), "origin", { allowNetwork: true }),
    ).toBe("release/2026");
  });

  it("asks the server when the cached ref is missing", async () => {
    const run = runner({
      [SETHEAD]: new Error("offline"),
      [SYMREF]: new Error("no symref"),
      "remote show origin": "* remote origin\n  HEAD branch: trunk\n",
    });
    expect(
      await defaultBranch(ctx(run), "origin", { allowNetwork: true }),
    ).toBe("trunk");
  });

  it("does not ask the server when the network is not allowed", async () => {
    const run = vi.fn(
      runner({
        [SYMREF]: new Error("no symref"),
        "rev-parse --verify --quiet refs/remotes/origin/main": "abc",
      }),
    );
    expect(
      await defaultBranch(ctx(run), "origin", { allowNetwork: false }),
    ).toBe("main");
    expect(run).not.toHaveBeenCalledWith(
      ["remote", "show", "origin"],
      expect.anything(),
    );
  });

  it("falls back to probing the conventional names", async () => {
    const run = runner({
      [SETHEAD]: new Error("offline"),
      [SYMREF]: new Error("no symref"),
      "remote show origin": new Error("offline"),
      "rev-parse --verify --quiet refs/remotes/origin/main": new Error("no"),
      "rev-parse --verify --quiet refs/remotes/origin/master": "abc123",
    });
    expect(
      await defaultBranch(ctx(run), "origin", { allowNetwork: true }),
    ).toBe("master");
  });

  // Guessing "main" here would produce a confident, wrong verdict.
  it("returns null rather than guessing", async () => {
    const run = runner({
      [SETHEAD]: new Error("offline"),
      [SYMREF]: new Error("no symref"),
      "remote show origin": new Error("offline"),
      "rev-parse --verify --quiet refs/remotes/origin/main": new Error("no"),
      "rev-parse --verify --quiet refs/remotes/origin/master": new Error("no"),
      "rev-parse --verify --quiet refs/remotes/origin/trunk": new Error("no"),
    });
    expect(
      await defaultBranch(ctx(run), "origin", { allowNetwork: true }),
    ).toBeNull();
  });

  it("ignores a server that answers (unknown)", async () => {
    const run = runner({
      [SYMREF]: new Error("no symref"),
      "remote show origin": "  HEAD branch: (unknown)\n",
      "rev-parse --verify --quiet refs/remotes/origin/main": "abc",
    });
    expect(
      await defaultBranch(ctx(run), "origin", { allowNetwork: true }),
    ).toBe("main");
  });
});

describe("isAncestor", () => {
  const C = "cccccccccccccccccccccccccccccccccccccccc";
  const D = "dddddddddddddddddddddddddddddddddddddddd";

  it("is true when the commit is reachable", async () => {
    const run = runner({
      [`cat-file -e ${C}^{commit}`]: "",
      [`merge-base --is-ancestor ${C} ${D}`]: "",
    });
    expect(await isAncestor(ctx(run), C, D)).toBe(true);
  });

  it("is false when it is not", async () => {
    const run = runner({
      [`cat-file -e ${C}^{commit}`]: "",
      [`merge-base --is-ancestor ${C} ${D}`]: new GitCommandError(
        ["merge-base", "--is-ancestor", C, D],
        1,
        "",
      ),
    });
    expect(await isAncestor(ctx(run), C, D)).toBe(false);
  });

  // A ref cannot contain a commit the clone does not have. The error is the
  // shape real git produces: `cat-file -e <sha>^{commit}` on an object this
  // clone lacks exits 128 and says the name is not valid, because git resolves
  // the peel before it looks.
  it("is false when the commit is not in this clone", async () => {
    const run = runner({
      [`cat-file -e ${C}^{commit}`]: new GitCommandError(
        ["cat-file", "-e", `${C}^{commit}`],
        128,
        `fatal: Not a valid object name ${C}^{commit}`,
      ),
    });
    expect(await isAncestor(ctx(run), C, D)).toBe(false);
  });

  // The regression the 250 ms floor introduced. The presence probe runs on a
  // slice of the shared hook deadline, and a slice can run out: `gitOrNull`
  // collapsed that timeout to null, this function reported the publication
  // commit absent, the platform fallback read that as `behind`, and
  // `blockStaleRuns` refused the prompt over a local git timeout. A killed
  // probe has to stay unknown.
  it("is null when the presence probe is killed by its timeout", async () => {
    const run = runner({
      [`cat-file -e ${C}^{commit}`]: new GitCommandError(
        ["cat-file", "-e", `${C}^{commit}`],
        null,
        "",
        "SIGTERM",
      ),
    });
    expect(await isAncestor(ctx(run), C, D)).toBeNull();
  });

  // An injected runner (a host with its own git abstraction) that throws
  // something this package cannot read established no fact either.
  it("is null when the presence probe fails in a way it cannot read", async () => {
    const run = runner({
      [`cat-file -e ${C}^{commit}`]: new Error("runner exploded"),
    });
    expect(await isAncestor(ctx(run), C, D)).toBeNull();
  });

  // A corrupt object database is not a missing object. Git exits 128 for
  // both, so the message is what separates them, and only the "this name
  // resolves to nothing" messages are read as absent.
  it("is null when the object database is corrupt", async () => {
    const run = runner({
      [`cat-file -e ${C}^{commit}`]: new GitCommandError(
        ["cat-file", "-e", `${C}^{commit}`],
        128,
        "error: object file .git/objects/ab/cd is empty",
      ),
    });
    expect(await isAncestor(ctx(run), C, D)).toBeNull();
  });

  // Only exit 1 means "not an ancestor". A timeout or a corrupt object
  // database is no answer at all, and reading it as "no" blocked prompts over
  // a plumbing failure.
  it("is null when git fails for any reason other than exit 1", async () => {
    const run = runner({
      [`cat-file -e ${C}^{commit}`]: "",
      [`merge-base --is-ancestor ${C} ${D}`]: new GitCommandError(
        ["merge-base", "--is-ancestor", C, D],
        128,
        "fatal: bad object",
      ),
    });
    expect(await isAncestor(ctx(run), C, D)).toBeNull();
  });
});

describe("commitPresent", () => {
  const C = "cccccccccccccccccccccccccccccccccccccccc";

  it("is true when cat-file succeeds", async () => {
    const run = runner({ [`cat-file -e ${C}^{commit}`]: "" });
    expect(await commitPresent(ctx(run), C)).toBe(true);
  });

  it("is false on exit 1, git's plain no", async () => {
    const run = runner({
      [`cat-file -e ${C}^{commit}`]: new GitCommandError(
        ["cat-file", "-e", `${C}^{commit}`],
        1,
        "",
      ),
    });
    expect(await commitPresent(ctx(run), C)).toBe(false);
  });

  it("is null when the command was killed", async () => {
    const run = runner({
      [`cat-file -e ${C}^{commit}`]: new GitCommandError(
        ["cat-file", "-e", `${C}^{commit}`],
        null,
        "",
        "SIGTERM",
      ),
    });
    expect(await commitPresent(ctx(run), C)).toBeNull();
  });
});

describe("classifyProbeFailure", () => {
  it("reads a killed command as unanswered, whatever its exit code", () => {
    expect(
      classifyProbeFailure(new GitCommandError([], 1, "", "SIGKILL")),
    ).toBe("unanswered");
  });

  it("reads exit 1 as absent", () => {
    expect(classifyProbeFailure(new GitCommandError([], 1, ""))).toBe("absent");
  });

  it("reads git's not-a-valid-name messages as absent", () => {
    for (const stderr of [
      "fatal: Not a valid object name abc^{commit}",
      "fatal: bad object abc",
      "fatal: ambiguous argument: unknown revision or path not in the working tree",
    ]) {
      expect(classifyProbeFailure(new GitCommandError([], 128, stderr))).toBe(
        "absent",
      );
    }
  });

  it("reads anything else as unanswered", () => {
    expect(
      classifyProbeFailure(new GitCommandError([], 128, "fatal: oops")),
    ).toBe("unanswered");
    expect(classifyProbeFailure(new Error("no idea"))).toBe("unanswered");
  });
});

describe("fetchBranch", () => {
  it("reports failure instead of throwing, so a check can carry on offline", async () => {
    const run = runner({});
    const result = await fetchBranch(ctx(run), "origin", "main");
    expect(result.ok).toBe(false);
  });

  it("fetches into the remote-tracking ref explicitly", async () => {
    const run = vi.fn(async () => "");
    await fetchBranch(ctx(run), "origin", "main");
    expect(run).toHaveBeenCalledWith(
      expect.arrayContaining([
        "fetch",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
      ]),
      expect.anything(),
    );
  });
});
