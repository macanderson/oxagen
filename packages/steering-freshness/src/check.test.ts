import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  checkSteeringFreshness,
  isStale,
  isSyncSafe,
  steeringPathspec,
} from "./check";
import { resolveSteeringPolicy, type SteeringPolicy } from "./policy";
import type { CacheIo } from "./cache";
import { GitCommandError, isSafeRefName, type GitRunner } from "./git";

const HEAD = "1111111111111111111111111111111111111111";
const REMOTE = "2222222222222222222222222222222222222222";
const BASE = "3333333333333333333333333333333333333333";
const PROMOTION = "4444444444444444444444444444444444444444";

const policy = (over: Partial<SteeringPolicy> = {}): SteeringPolicy => ({
  ...resolveSteeringPolicy([]),
  ...over,
});

/** Everything a healthy repository answers. Override one key per test. */
function table(
  over: Record<string, string | Error> = {},
): Record<string, string | Error> {
  return {
    "rev-parse --show-toplevel": "/repo",
    "rev-parse --verify --quiet HEAD^{commit}": HEAD,
    "symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main",
    "rev-parse --git-common-dir": "/repo/.git",
    // The remotes this repository has. The check refuses a remote name that is
    // not one of them before any git call uses it.
    remote: "origin",
    "fetch --quiet --no-tags --no-write-fetch-head -- origin +refs/heads/main:refs/remotes/origin/main":
      "",
    "rev-parse --verify --quiet refs/remotes/origin/main^{commit}": REMOTE,
    [`merge-base ${HEAD} ${REMOTE}`]: BASE,
    [`diff --name-status --no-renames -z ${BASE} ${REMOTE} -- .oxagen :(exclude).oxagen/settings.local.json :(exclude).oxagen/workspace.json`]:
      "",
    [`diff --name-status --no-renames -z ${BASE} ${HEAD} -- .oxagen :(exclude).oxagen/settings.local.json :(exclude).oxagen/workspace.json`]:
      "",
    "status --porcelain=v1 -z --untracked-files=all --ignored=matching -- .oxagen :(exclude).oxagen/settings.local.json :(exclude).oxagen/workspace.json":
      "",
    [`rev-list --count ${BASE}..${REMOTE} -- .oxagen`]: "0",
    [`rev-parse ${HEAD}:.oxagen`]: "aaaa",
    [`rev-parse ${REMOTE}:.oxagen`]: "bbbb",
    ...over,
  };
}

function runner(t: Record<string, string | Error>): GitRunner {
  return async (args) => {
    const key = args.join(" ");
    const hit = t[key];
    if (hit !== undefined) {
      if (hit instanceof Error) throw hit;
      return hit;
    }
    // The working-copy comparison, `diff <remoteHead> -- <paths>`. Unless a
    // test says otherwise, every candidate path still differs from the
    // production branch, which is the ordinary case.
    if (key.startsWith(`diff --name-status --no-renames -z ${REMOTE} --`)) {
      return args
        .slice(args.indexOf("--") + 1)
        .map((path) => `M\0${path}\0`)
        .join("");
    }
    // Untracked files under the given paths. None, unless a test says so.
    if (key.startsWith("ls-files --others -z --")) return "";
    // Index entries excluded from the working tree. None, unless a test says so.
    if (key.startsWith("ls-files -t -z --")) return "";
    // Production's blob for each path. Every path, unless a test says so.
    if (key.startsWith(`ls-tree -r -z ${REMOTE} --`)) {
      return args
        .slice(args.indexOf("--") + 1)
        .map((path) => `100644 blob remote-${path}\t${path}\0`)
        .join("");
    }
    // The index's blob for each path.
    if (key.startsWith("ls-files -s -z --")) {
      return args
        .slice(args.indexOf("--") + 1)
        .map((path) => `100644 index-${path} 0\t${path}\0`)
        .join("");
    }
    // The working copy's blob for each path. Production's, unless a test
    // says so: the file on disk holds what production holds.
    if (key.startsWith("hash-object --")) {
      return args
        .slice(args.indexOf("--") + 1)
        .map((path) => `remote-${path}\n`)
        .join("");
    }
    throw new Error(`unexpected git ${key}`);
  };
}

/** The working copy already holds these paths, so they drop out of both sides. */
const alreadyTaken = (
  t: Record<string, string | Error>,
  paths: readonly string[],
) => ({
  ...t,
  [`diff --name-status --no-renames -z ${REMOTE} -- ${paths.join(" ")}`]: "",
});

const noCache: CacheIo = {
  read: (async () => {
    throw new Error("none");
  }) as unknown as CacheIo["read"],
  write: (async () => undefined) as unknown as CacheIo["write"],
  mkdirp: async () => undefined,
};

const REMOTE_ADDED = `A\0.oxagen/rules/ctx.release.pin.toml\0`;
const LOCAL_ADDED = `A\0.oxagen/rules/ctx.mine.draft.toml\0`;
const remoteDiff = (t: Record<string, string | Error>, value: string) => ({
  ...t,
  [`diff --name-status --no-renames -z ${BASE} ${REMOTE} -- .oxagen :(exclude).oxagen/settings.local.json :(exclude).oxagen/workspace.json`]:
    value,
});
const localDiff = (t: Record<string, string | Error>, value: string) => ({
  ...t,
  [`diff --name-status --no-renames -z ${BASE} ${HEAD} -- .oxagen :(exclude).oxagen/settings.local.json :(exclude).oxagen/workspace.json`]:
    value,
});

function check(
  t: Record<string, string | Error>,
  over: Partial<Parameters<typeof checkSteeringFreshness>[0]> = {},
) {
  return checkSteeringFreshness({
    cwd: "/repo/sub",
    policy: policy(),
    run: runner(t),
    cacheIo: noCache,
    now: () => 1_000_000,
    ...over,
  });
}

describe("steeringPathspec", () => {
  it("puts the positive pathspec first, so the excludes subtract from it", () => {
    const { pathspecs } = steeringPathspec(policy());
    expect(pathspecs).toEqual([
      ".oxagen",
      ":(exclude).oxagen/settings.local.json",
      ":(exclude).oxagen/workspace.json",
    ]);
  });
});

describe("checkSteeringFreshness", () => {
  it("is current when neither side touched .oxagen", async () => {
    const v = await check(table());
    expect(v.status).toBe("current");
    expect(isStale(v)).toBe(false);
    expect(v.branch).toBe("main");
    expect(v.fingerprint).toEqual({ local: "aaaa", remote: "bbbb" });
  });

  it("is behind when the production branch gained a record", async () => {
    const v = await check(
      remoteDiff(
        table({ [`rev-list --count ${BASE}..${REMOTE} -- .oxagen`]: "2" }),
        REMOTE_ADDED,
      ),
    );
    expect(v.status).toBe("behind");
    expect(isStale(v)).toBe(true);
    expect(v.missing).toEqual([
      { status: "added", path: ".oxagen/rules/ctx.release.pin.toml" },
    ]);
    expect(v.behindByCommits).toBe(2);
    expect(isSyncSafe(v)).toBe(true);
  });

  // The case a naive directory comparison gets wrong: authoring a record is
  // not staleness, and must never block.
  it("is ahead, not behind, when only this branch changed .oxagen", async () => {
    const v = await check(localDiff(table(), LOCAL_ADDED));
    expect(v.status).toBe("ahead");
    expect(isStale(v)).toBe(false);
  });

  it("is diverged when both sides changed .oxagen", async () => {
    const v = await check(
      localDiff(remoteDiff(table(), REMOTE_ADDED), LOCAL_ADDED),
    );
    expect(v.status).toBe("diverged");
    expect(isStale(v)).toBe(true);
    expect(isSyncSafe(v)).toBe(false);
  });

  // Dirt is reported beside the status, not folded into it: an unsaved edit
  // is not a divergence, but it does make a sync unsafe.
  it("reports an uncommitted edit without calling it a divergence", async () => {
    const v = await check(
      remoteDiff(
        table({
          "status --porcelain=v1 -z --untracked-files=all --ignored=matching -- .oxagen :(exclude).oxagen/settings.local.json :(exclude).oxagen/workspace.json":
            " M .oxagen/rules/ctx.mine.toml\0",
        }),
        REMOTE_ADDED,
      ),
    );
    expect(v.status).toBe("behind");
    expect(v.dirty).toEqual([".oxagen/rules/ctx.mine.toml"]);
    expect(isSyncSafe(v)).toBe(false);
  });

  // A sync writes the files without moving HEAD, so the merge-base diff keeps
  // naming them. Judging on the commit alone would block a prompt over
  // records already on disk.
  it("is current once the working copy holds the merged records, committed or not", async () => {
    const v = await check(
      alreadyTaken(remoteDiff(table(), REMOTE_ADDED), [
        ".oxagen/rules/ctx.release.pin.toml",
      ]),
    );
    expect(v.status).toBe("current");
    expect(v.missing).toEqual([]);
  });

  // The mirror case: committing a sync makes those paths look authored here,
  // and an unfiltered local side would refuse the next sync to protect a
  // file identical to the production branch's.
  it("does not count a path identical to the production branch as authoring", async () => {
    const v = await check(
      alreadyTaken(localDiff(remoteDiff(table(), REMOTE_ADDED), LOCAL_ADDED), [
        ".oxagen/rules/ctx.mine.draft.toml",
      ]),
    );
    expect(v.status).toBe("behind");
    expect(v.local).toEqual([]);
    expect(isSyncSafe(v)).toBe(true);
  });

  it("stays current when .oxagen is merely dirty", async () => {
    const v = await check(
      table({
        "status --porcelain=v1 -z --untracked-files=all --ignored=matching -- .oxagen :(exclude).oxagen/settings.local.json :(exclude).oxagen/workspace.json":
          "?? .oxagen/rules/ctx.new.toml\0",
      }),
    );
    expect(v.status).toBe("current");
    expect(v.dirty).toEqual([".oxagen/rules/ctx.new.toml"]);
  });
});

describe("checkSteeringFreshness, when it cannot answer", () => {
  it("is unknown outside a git repository", async () => {
    const v = await check({
      "rev-parse --show-toplevel": new Error("not a repo"),
    });
    expect(v.status).toBe("unknown");
    expect(v.notes[0]).toContain("not inside a git repository");
    expect(isStale(v)).toBe(false);
  });

  it("is unknown in a repository with no commits", async () => {
    const v = await check(
      table({
        "rev-parse --verify --quiet HEAD^{commit}": new Error("no HEAD"),
      }),
    );
    expect(v.status).toBe("unknown");
    expect(v.notes[0]).toContain("no commits");
  });

  it("is unknown when the default branch cannot be worked out", async () => {
    const v = await check(
      table({
        "symbolic-ref --quiet --short refs/remotes/origin/HEAD": new Error(
          "none",
        ),
        "remote show origin": new Error("offline"),
        "rev-parse --verify --quiet refs/remotes/origin/main": new Error("no"),
        "rev-parse --verify --quiet refs/remotes/origin/master": new Error(
          "no",
        ),
        "rev-parse --verify --quiet refs/remotes/origin/trunk": new Error("no"),
      }),
    );
    expect(v.status).toBe("unknown");
    expect(v.notes[0]).toContain("default branch");
  });

  it("is unknown when the remote-tracking ref is not on disk", async () => {
    const v = await check(
      table({
        "rev-parse --verify --quiet refs/remotes/origin/main^{commit}": new Error("none"),
      }),
    );
    expect(v.status).toBe("unknown");
    expect(v.notes.at(-1)).toContain("git fetch origin");
  });

  it("is unknown when the histories share no ancestor", async () => {
    const v = await check(
      table({ [`merge-base ${HEAD} ${REMOTE}`]: new Error("none") }),
    );
    expect(v.status).toBe("unknown");
    expect(v.notes.at(-1)).toContain("common ancestor");
  });

  // Offline is the common case, and it must produce a verdict, not an error.
  it("still answers from the ref on disk when the fetch fails", async () => {
    const v = await check(
      remoteDiff(
        table({
          "fetch --quiet --no-tags --no-write-fetch-head -- origin +refs/heads/main:refs/remotes/origin/main":
            new Error("could not resolve host"),
        }),
        REMOTE_ADDED,
      ),
    );
    expect(v.status).toBe("behind");
    expect(v.fetch).toEqual({
      attempted: true,
      ok: false,
      reason: expect.stringContaining("could not resolve host"),
    });
    expect(v.notes[0]).toContain("could not reach origin");
  });
});

describe("checkSteeringFreshness, network behaviour", () => {
  it("does not fetch when the caller forbids it", async () => {
    const run = vi.fn(runner(table()));
    const v = await check(table(), { run, allowNetwork: false });
    expect(v.fetch.attempted).toBe(false);
    const fetched = run.mock.calls.some(([args]) => args[0] === "fetch");
    expect(fetched).toBe(false);
  });

  it("skips the fetch while the throttle stamp is fresh", async () => {
    const stamp = JSON.stringify({
      attemptedAt: 1_000_000,
      target: "origin/main",
      ok: true,
    });
    const io: CacheIo = {
      read: (async () => stamp) as unknown as CacheIo["read"],
      write: (async () => undefined) as unknown as CacheIo["write"],
      mkdirp: async () => undefined,
    };
    const run = vi.fn(runner(table()));
    const v = await check(table(), { run, cacheIo: io });
    expect(v.fetch.attempted).toBe(false);
    expect(run.mock.calls.some(([args]) => args[0] === "fetch")).toBe(false);
  });

  it("runs every git call from the repository root, not the caller's cwd", async () => {
    const seen: string[] = [];
    const base = runner(table());
    const run: GitRunner = async (args, opts) => {
      seen.push(opts.cwd);
      return base(args, opts);
    };
    await check(table(), { run });
    // The first call discovers the root from the caller's directory; every
    // later one is pinned to it, so `.oxagen` means the same thing.
    expect(seen[0]).toBe("/repo/sub");
    expect(new Set(seen.slice(1))).toEqual(new Set(["/repo"]));
  });
});

describe("checkSteeringFreshness, the platform signal", () => {
  it("reports behind when Oxagen knows of a promotion git has not seen", async () => {
    const v = await check(table(), {
      platform: {
        steeringVersion: 42,
        headCommit: "deadbeef",
        aheadOfCheckout: true,
      },
    });
    expect(v.status).toBe("behind");
    expect(v.notes[0]).toContain("steering version 42");
  });

  it("leaves a current checkout alone when the platform agrees", async () => {
    const v = await check(table(), {
      platform: {
        steeringVersion: 42,
        headCommit: "deadbeef",
        aheadOfCheckout: false,
      },
    });
    expect(v.status).toBe("current");
  });

  it("does not double-report when git already found the records", async () => {
    const v = await check(remoteDiff(table(), REMOTE_ADDED), {
      platform: {
        steeringVersion: 42,
        headCommit: "deadbeef",
        aheadOfCheckout: true,
      },
    });
    expect(v.status).toBe("behind");
    expect(v.notes.filter((n) => n.includes("steering version"))).toHaveLength(
      0,
    );
  });

  // A sync writes and stages the files without moving HEAD, so the platform
  // signal it was given still says `aheadOfCheckout` on the re-check. What
  // has changed is the remote-tracking ref: it now reaches the published
  // commit, and nothing is outstanding. Reporting `behind` here made
  // `autoSync + blockStaleRuns` exit 2 immediately after installing every
  // missing record.
  it("clears platform staleness once the fetched ref holds the promotion", async () => {
    const v = await check(
      {
        ...table(),
        [`cat-file -e ${PROMOTION}^{commit}`]: "",
        [`merge-base --is-ancestor ${PROMOTION} ${REMOTE}`]: "",
      },
      {
        platform: {
          steeringVersion: 42,
          headCommit: PROMOTION,
          aheadOfCheckout: true,
        },
      },
    );
    expect(v.status).toBe("current");
    expect(v.notes.filter((n) => n.includes("steering version"))).toHaveLength(
      0,
    );
  });

  it("keeps reporting behind when the ref cannot reach the promotion", async () => {
    const v = await check(
      {
        ...table(),
        [`cat-file -e ${PROMOTION}^{commit}`]: "",
        [`merge-base --is-ancestor ${PROMOTION} ${REMOTE}`]:
          new GitCommandError(
            ["merge-base", "--is-ancestor", PROMOTION, REMOTE],
            1,
            "",
          ),
      },
      {
        platform: {
          steeringVersion: 42,
          headCommit: PROMOTION,
          aheadOfCheckout: true,
        },
      },
    );
    expect(v.status).toBe("behind");
    expect(v.notes[0]).toContain("steering version 42");
  });
});

// Git failing to answer is not staleness. Reading a timeout or a corrupt
// object database as "the ref lacks the promotion" blocked prompts over a
// plumbing failure.
describe("checkSteeringFreshness, when the ancestry question fails", () => {
  it("is unknown, not behind", async () => {
    const v = await check(
      {
        ...table(),
        [`cat-file -e ${PROMOTION}^{commit}`]: "",
        [`merge-base --is-ancestor ${PROMOTION} ${REMOTE}`]:
          new GitCommandError(
            ["merge-base", "--is-ancestor", PROMOTION, REMOTE],
            128,
            "fatal: bad object",
          ),
      },
      {
        platform: {
          steeringVersion: 42,
          headCommit: PROMOTION,
          aheadOfCheckout: true,
        },
      },
    );
    expect(v.status).toBe("unknown");
    expect(v.notes.join(" ")).toContain("steering version 42");
  });
});

// The contract is that an ordinary failure is `unknown` with a note, never a
// throw: `steering status` and `steering sync` crash on an exception, and the
// prompt hook catches it and allows the run with no diagnostic at all.
describe("checkSteeringFreshness, a comparison that cannot run", () => {
  it("is unknown, not a throw, when the diff fails", async () => {
    const v = await check({
      ...table(),
      [`diff --name-status --no-renames -z ${BASE} ${REMOTE} -- .oxagen :(exclude).oxagen/settings.local.json :(exclude).oxagen/workspace.json`]:
        new Error("fatal: unable to read object"),
    });
    expect(v.status).toBe("unknown");
    expect(v.notes.join(" ")).toContain("unable to read object");
  });

  it("is unknown, not a throw, when status fails", async () => {
    const v = await check({
      ...table(),
      "status --porcelain=v1 -z --untracked-files=all --ignored=matching -- .oxagen :(exclude).oxagen/settings.local.json :(exclude).oxagen/workspace.json":
        new Error("fatal: not a git repository"),
    });
    expect(v.status).toBe("unknown");
    expect(v.notes.join(" ")).toContain("not a git repository");
  });
});

// `.oxagen/settings.json` is committed, so whoever wrote the checkout controls
// `remote` and `branch`. Git reads a leading `-` as an option, and
// `git fetch --upload-pack=<command>` runs that command, so a hostile checkout
// could execute code the first time `steering status` or the prompt gate ran.
describe("checkSteeringFreshness, remote and branch names from settings", () => {
  const INJECT = "--upload-pack=touch /tmp/pwn #";

  it("refuses an option-like remote before any git command sees it", async () => {
    const run = vi.fn(runner(table()));
    const v = await check(table(), {
      run,
      policy: policy({ remote: INJECT, branch: "main" }),
    });
    expect(v.status).toBe("unknown");
    const seen = run.mock.calls.map(([args]) => args.join(" "));
    expect(seen.some((cmd) => cmd.includes("upload-pack"))).toBe(false);
    expect(seen.some((cmd) => cmd.startsWith("fetch"))).toBe(false);
  });

  it("refuses an option-like branch the same way", async () => {
    const run = vi.fn(runner(table()));
    const v = await check(table(), {
      run,
      policy: policy({ branch: "--output=/tmp/x" }),
    });
    expect(v.status).toBe("unknown");
    const seen = run.mock.calls.map(([args]) => args.join(" "));
    expect(seen.some((cmd) => cmd.includes("--output"))).toBe(false);
  });

  // A settings file cannot invent a remote. One the repository does not have
  // is refused, however ordinary its name.
  it("refuses a remote this repository has not configured", async () => {
    const run = vi.fn(runner(table()));
    const v = await check(table(), {
      run,
      policy: policy({ remote: "evil" }),
    });
    expect(v.status).toBe("unknown");
    expect(v.notes.join(" ")).toContain('no remote named "evil"');
    expect(run.mock.calls.some(([args]) => args[0] === "fetch")).toBe(false);
  });
});

describe("isSafeRefName", () => {
  it.each(["origin", "upstream", "main", "release/2026", "feature-x", "v1.2"])(
    "accepts %s",
    (name) => {
      expect(isSafeRefName(name)).toBe(true);
    },
  );

  it.each([
    "",
    "-x",
    "--upload-pack=touch /tmp/pwn",
    "a b",
    "a..b",
    "/abs",
    "trailing/",
    "a//b",
    "a@{1}",
    "tab\tname",
  ])("refuses %j", (name) => {
    expect(isSafeRefName(name)).toBe(false);
  });
});

// Every network call used to carry its own full timeout, so a slow remote
// spent them one after another and blew past the hook's own budget; the
// harness killed the gate and allowed the prompt.
describe("checkSteeringFreshness, the network budget", () => {
  it("gives the fetch only what the branch refresh left", async () => {
    let clock = 1_000_000;
    const seen: { cmd: string; timeoutMs: number }[] = [];
    const base = runner(table());
    const run: GitRunner = async (args, opts) => {
      const cmd = args.join(" ");
      seen.push({ cmd, timeoutMs: opts.timeoutMs });
      // The refresh takes 3 seconds of a 5-second budget.
      if (cmd === "remote set-head origin --auto") clock += 3_000;
      return base(args, opts);
    };
    await check(table(), {
      run,
      now: () => clock,
      timeoutMs: 10_000,
      networkBudgetMs: 5_000,
    });
    const refresh = seen.find((c) => c.cmd === "remote set-head origin --auto");
    const fetch = seen.find((c) => c.cmd.startsWith("fetch "));
    expect(refresh?.timeoutMs).toBe(5_000);
    expect(fetch?.timeoutMs).toBe(2_000);
  });

  // `defaultBranch` makes two network calls in sequence from one context: the
  // cached-HEAD refresh, then `remote show` when the cached ref is absent. A
  // timeout snapshotted when the context was built gave each the whole
  // remainder, so the pair could spend twice the budget.
  it("gives the second call inside defaultBranch only what the first left", async () => {
    let clock = 1_000_000;
    const seen: { cmd: string; timeoutMs: number }[] = [];
    const base = runner({
      ...table(),
      // No cached HEAD, so the fallback asks the server.
      "symbolic-ref --quiet --short refs/remotes/origin/HEAD": new Error(
        "no such ref",
      ),
      "remote show origin": "* remote origin\n  HEAD branch: main\n",
    });
    const run: GitRunner = async (args, opts) => {
      const cmd = args.join(" ");
      seen.push({ cmd, timeoutMs: opts.timeoutMs });
      // The refresh takes 3 seconds of a 5-second budget.
      if (cmd === "remote set-head origin --auto") clock += 3_000;
      // And the server takes another 1.5.
      if (cmd === "remote show origin") clock += 1_500;
      return base(args, opts);
    };
    const v = await check(table(), {
      run,
      now: () => clock,
      timeoutMs: 10_000,
      networkBudgetMs: 5_000,
    });
    expect(v.branch).toBe("main");
    const refresh = seen.find((c) => c.cmd === "remote set-head origin --auto");
    const show = seen.find((c) => c.cmd === "remote show origin");
    const fetch = seen.find((c) => c.cmd.startsWith("fetch "));
    expect(refresh?.timeoutMs).toBe(5_000);
    expect(show?.timeoutMs).toBe(2_000);
    // Past the deadline: the floor, so it fails fast rather than hanging.
    expect(fetch?.timeoutMs).toBe(1_000);
  });

  it("leaves local git calls on their own timeout", async () => {
    const seen: { cmd: string; timeoutMs: number }[] = [];
    const base = runner(table());
    const run: GitRunner = async (args, opts) => {
      seen.push({ cmd: args.join(" "), timeoutMs: opts.timeoutMs });
      return base(args, opts);
    };
    await check(table(), { run, timeoutMs: 10_000, networkBudgetMs: 5_000 });
    const local = seen.find((c) => c.cmd.startsWith("diff "));
    expect(local?.timeoutMs).toBe(10_000);
  });
});

// `git diff <commit>` never sees an untracked file, so a record production
// removed, whose deletion this checkout staged while the file stayed on disk,
// read as "same as production" and the verdict said `current` while the agent
// went on reading it.
describe("checkSteeringFreshness, a removed record still on disk", () => {
  const REMOVED = `D\0.oxagen/rules/ctx.retired.toml\0`;

  it("is still behind when the removed path exists untracked", async () => {
    const v = await check({
      ...remoteDiff(table(), REMOVED),
      // The staged deletion makes the diff against production say "same".
      [`diff --name-status --no-renames -z ${REMOTE} -- .oxagen/rules/ctx.retired.toml`]:
        "",
      // But the file is right there, untracked.
      "ls-files --others -z -- .oxagen/rules/ctx.retired.toml":
        ".oxagen/rules/ctx.retired.toml\0",
    });
    expect(v.status).toBe("behind");
    expect(v.missing.map((c) => c.path)).toEqual([
      ".oxagen/rules/ctx.retired.toml",
    ]);
  });

  it("is current once the removed path is really gone", async () => {
    const v = await check({
      ...remoteDiff(table(), REMOVED),
      [`diff --name-status --no-renames -z ${REMOTE} -- .oxagen/rules/ctx.retired.toml`]:
        "",
    });
    expect(v.status).toBe("current");
  });
});

// A sparse checkout keeps governed records in the index while removing them
// from disk. Every diff read them as present and `status` was clean, so the
// verdict said `current` while the agent had none of its records.
// Git's revision DWIM reads `refs/heads/<name>` before `refs/remotes/<name>`,
// so a checkout holding a LOCAL branch called `origin/main` answered with
// that branch. The check then compared against a ref the fetch never moves
// and reported `current` while production had advanced.
describe("a checkout with a local branch named like the remote-tracking ref", () => {
  it("resolves the remote tip by its full ref", async () => {
    const v = await check(
      remoteDiff(
        {
          ...table({ [`rev-list --count ${BASE}..${REMOTE} -- .oxagen`]: "2" }),
          // The short name resolves to the local branch, which is HEAD. A
          // check that read it would compare HEAD with itself and answer
          // `current`; every key below is keyed on the remote tip.
          "rev-parse --verify --quiet origin/main^{commit}": HEAD,
        },
        REMOTE_ADDED,
      ),
    );
    expect(v.status, v.notes.join(" | ")).toBe("behind");
    expect(v.missing).toEqual([
      { status: "added", path: ".oxagen/rules/ctx.release.pin.toml" },
    ]);
  });
});

describe("checkSteeringFreshness, governed files excluded from the working tree", () => {
  it("is behind, naming the excluded files, when the index matches but the disk does not", async () => {
    const v = await check({
      ...table(),
      "ls-files -t -z -- .oxagen :(exclude).oxagen/settings.local.json :(exclude).oxagen/workspace.json":
        "S .oxagen/rules/ctx.a.toml\0H .oxagen/workspace.json\0",
    });
    expect(v.status).toBe("behind");
    expect(v.missing.map((c) => c.path)).toEqual([".oxagen/rules/ctx.a.toml"]);
    expect(v.notes.join(" ")).toContain("excluded from this checkout");
  });

  // The `S` bit says git is not looking at the file, not that the file is
  // gone. A record materialised by hand and edited is on disk, and every
  // diff ignored the edit; calling it missing sent it to the auto-sync as
  // safe to restore, and the restore overwrote the edit without `force`.
  it("leaves a skip-worktree record alone when it is on disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "steering-check-"));
    await mkdir(join(root, ".oxagen/rules"), { recursive: true });
    await writeFile(join(root, ".oxagen/rules/ctx.a.toml"), "edited by hand\n");
    const v = await check(
      {
        ...table(),
        "rev-parse --show-toplevel": root,
        "ls-files -t -z -- .oxagen :(exclude).oxagen/settings.local.json :(exclude).oxagen/workspace.json":
          "S .oxagen/rules/ctx.a.toml\0S .oxagen/rules/ctx.b.toml\0",
      },
      { cwd: root },
    );
    expect(v.status).toBe("behind");
    // Only the record that is really absent is missing; the edited one is not
    // handed to the sync.
    expect(v.missing.map((c) => c.path)).toEqual([".oxagen/rules/ctx.b.toml"]);
  });

  it("is current when every skip-worktree record is on disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "steering-check-"));
    await mkdir(join(root, ".oxagen/rules"), { recursive: true });
    await writeFile(join(root, ".oxagen/rules/ctx.a.toml"), "edited by hand\n");
    const v = await check(
      {
        ...table(),
        "rev-parse --show-toplevel": root,
        "ls-files -t -z -- .oxagen :(exclude).oxagen/settings.local.json :(exclude).oxagen/workspace.json":
          "S .oxagen/rules/ctx.a.toml\0",
      },
      { cwd: root },
    );
    expect(v.status).toBe("current");
    expect(v.missing).toEqual([]);
  });

  // An entry that exists in this index alone, under skip-worktree, has
  // nothing in production to restore from; naming it missing would make the
  // sync's `restore --source` fail on a pathspec its source lacks.
  it("does not name a skipped record production does not hold", async () => {
    const v = await check({
      ...table(),
      "ls-files -t -z -- .oxagen :(exclude).oxagen/settings.local.json :(exclude).oxagen/workspace.json":
        "S .oxagen/rules/ctx.only-here.toml\0",
      [`ls-tree -r -z ${REMOTE} -- .oxagen/rules/ctx.only-here.toml`]: "",
    });
    expect(v.status).toBe("current");
    expect(v.missing).toEqual([]);
  });

  it("is unknown when production's tree cannot be read", async () => {
    const v = await check({
      ...table(),
      "ls-files -t -z -- .oxagen :(exclude).oxagen/settings.local.json :(exclude).oxagen/workspace.json":
        "S .oxagen/rules/ctx.a.toml\0",
      [`ls-tree -r -z ${REMOTE} -- .oxagen/rules/ctx.a.toml`]: new Error(
        "bad object",
      ),
    });
    expect(v.status).toBe("unknown");
    expect(v.notes.join(" ")).toContain("could not compare");
  });

  // The probe is the only check that sees a record a sparse checkout left
  // off disk. Reading its failure as "none skipped" let the verdict say
  // `current` with those records absent.
  it("is unknown when the skip-worktree probe fails", async () => {
    const v = await check({
      ...table(),
      "ls-files -t -z -- .oxagen :(exclude).oxagen/settings.local.json :(exclude).oxagen/workspace.json":
        new Error("index file corrupt"),
    });
    expect(v.status).toBe("unknown");
    expect(v.notes.join(" ")).toContain("could not compare");
  });

  // Excluded records are outstanding alongside whatever else production
  // changed, so one sync puts everything on disk rather than two.
  it("names excluded records next to the other outstanding ones", async () => {
    const v = await check({
      ...remoteDiff(table(), `M\0.oxagen/rules/ctx.b.toml\0`),
      "ls-files -t -z -- .oxagen :(exclude).oxagen/settings.local.json :(exclude).oxagen/workspace.json":
        "S .oxagen/rules/ctx.a.toml\0",
    });
    expect(v.status).toBe("behind");
    expect(v.missing.map((c) => c.path).sort()).toEqual([
      ".oxagen/rules/ctx.a.toml",
      ".oxagen/rules/ctx.b.toml",
    ]);
  });
});

// `diff` and `status` read the index in place of a skip-worktree file, so an
// edit to the materialised file on disk is invisible to both. When production
// changed the same record, the verdict was `behind` with `dirty` empty, and
// the auto-sync's `restore --ignore-skip-worktree-bits` overwrote the edit
// with `force` false. The file itself is now compared, three ways.
describe("checkSteeringFreshness, a materialised skip-worktree record", () => {
  const LS =
    "ls-files -t -z -- .oxagen :(exclude).oxagen/settings.local.json :(exclude).oxagen/workspace.json";
  const A = ".oxagen/rules/ctx.a.toml";

  async function materialised(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "steering-check-"));
    await mkdir(join(root, ".oxagen/rules"), { recursive: true });
    await writeFile(join(root, A), "whatever is on disk\n");
    return root;
  }

  it("is dirt when the file matches neither the index nor production", async () => {
    const root = await materialised();
    const v = await check(
      {
        ...remoteDiff(table(), `M\0${A}\0`),
        "rev-parse --show-toplevel": root,
        [LS]: `S ${A}\0`,
        [`hash-object -- ${A}`]: "edited-by-hand\n",
      },
      { cwd: root },
    );
    expect(v.status).toBe("behind");
    expect(v.missing.map((c) => c.path)).toEqual([A]);
    expect(v.dirty).toEqual([A]);
    expect(isSyncSafe(v)).toBe(false);
  });

  it("is not dirt when the file still holds the index's bytes", async () => {
    const root = await materialised();
    const v = await check(
      {
        ...remoteDiff(table(), `M\0${A}\0`),
        "rev-parse --show-toplevel": root,
        [LS]: `S ${A}\0`,
        [`hash-object -- ${A}`]: `index-${A}\n`,
      },
      { cwd: root },
    );
    expect(v.status).toBe("behind");
    expect(v.missing.map((c) => c.path)).toEqual([A]);
    expect(v.dirty).toEqual([]);
    expect(isSyncSafe(v)).toBe(true);
  });

  it("is current, and not this checkout's work, when the file holds production's bytes", async () => {
    const root = await materialised();
    const v = await check(
      {
        ...remoteDiff(table(), `M\0${A}\0`),
        ...localDiff(table(), `M\0${A}\0`),
        "rev-parse --show-toplevel": root,
        [LS]: `S ${A}\0`,
        [`hash-object -- ${A}`]: `remote-${A}\n`,
      },
      { cwd: root },
    );
    expect(v.status).toBe("current");
    expect(v.missing).toEqual([]);
    expect(v.local).toEqual([]);
    expect(v.dirty).toEqual([]);
  });

  it("is dirt when production retired the record and a copy is on disk", async () => {
    const root = await materialised();
    const v = await check(
      {
        ...table(),
        "rev-parse --show-toplevel": root,
        [LS]: `S ${A}\0`,
        [`ls-tree -r -z ${REMOTE} -- ${A}`]: "",
        [`hash-object -- ${A}`]: "anything\n",
      },
      { cwd: root },
    );
    expect(v.dirty).toEqual([A]);
  });

  it("is unknown when the file cannot be hashed", async () => {
    const root = await materialised();
    const v = await check(
      {
        ...table(),
        "rev-parse --show-toplevel": root,
        [LS]: `S ${A}\0`,
        [`hash-object -- ${A}`]: new Error("unreadable"),
      },
      { cwd: root },
    );
    expect(v.status).toBe("unknown");
    expect(v.notes.join(" ")).toContain("unreadable");
  });
});
