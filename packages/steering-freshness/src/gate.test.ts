import { describe, expect, it, vi } from "vitest";
import { evaluateGate } from "./gate";
import { resolveSteeringPolicy } from "./policy";
import type { CacheIo } from "./cache";
import { GitCommandError, type GitRunner } from "./git";

const HEAD = "1111111111111111111111111111111111111111";
const REMOTE = "2222222222222222222222222222222222222222";
const BASE = "3333333333333333333333333333333333333333";
const EXCL =
  ":(exclude).oxagen/settings.local.json :(exclude).oxagen/workspace.json";

/**
 * A runner whose remote-side diff can be emptied, which is how a sync is
 * simulated: the gate re-checks after a successful sync, and the second
 * check must see a clean checkout.
 */
function stubRepo({ behind }: { behind: boolean }) {
  const state = { behind };
  const run: GitRunner = async (args) => {
    const key = args.join(" ");
    switch (key) {
      case "rev-parse --show-toplevel":
        return "/repo";
      case "rev-parse --verify --quiet HEAD^{commit}":
        return HEAD;
      case "symbolic-ref --quiet --short refs/remotes/origin/HEAD":
        return "origin/main";
      case "rev-parse --git-common-dir":
        return "/repo/.git";
      case "remote":
        return "origin";
      case "rev-parse --verify --quiet refs/remotes/origin/main^{commit}":
        return REMOTE;
      case `merge-base ${HEAD} ${REMOTE}`:
        return BASE;
      case `diff --name-status --no-renames -z ${BASE} ${REMOTE} -- .oxagen ${EXCL}`:
        return state.behind ? "A\0.oxagen/rules/ctx.a.toml\0" : "";
      case `diff --name-status --no-renames -z ${BASE} ${HEAD} -- .oxagen ${EXCL}`:
        return "";
      case `status --porcelain=v1 -z --untracked-files=all --ignored=matching -- .oxagen ${EXCL}`:
        return "";
      case `rev-list --count ${BASE}..${REMOTE} -- .oxagen`:
        return state.behind ? "1" : "0";
      case `rev-parse ${HEAD}:.oxagen`:
        return "aaaa";
      case `rev-parse ${REMOTE}:.oxagen`:
        return "bbbb";
      default:
        break;
    }
    if (key.startsWith(`diff --name-status --no-renames -z ${REMOTE} --`)) {
      // Every candidate path still differs from the production branch.
      return args
        .slice(args.indexOf("--") + 1)
        .map((path) => `M\0${path}\0`)
        .join("");
    }
    if (args[0] === "fetch") return "";
    // Nothing untracked under the governed tree, and no index entry left out
    // of the working tree. The skip-worktree probe fails loudly now, so the
    // stub has to answer it rather than fall through to the throw below.
    if (args[0] === "ls-files") return "";
    if (args[0] === "restore") {
      // The sync landed, so the checkout is no longer behind.
      state.behind = false;
      return "";
    }
    if (args[0] === "rev-parse") return REMOTE;
    throw new Error(`unexpected git ${key}`);
  };
  return { run, state };
}

const noCache: CacheIo = {
  read: (async () => {
    throw new Error("none");
  }) as unknown as CacheIo["read"],
  write: (async () => undefined) as unknown as CacheIo["write"],
  mkdirp: async () => undefined,
};

function gate(
  behind: boolean,
  file: Parameters<typeof resolveSteeringPolicy>[0][number]["policy"] = {},
  over: Partial<Parameters<typeof evaluateGate>[0]> = {},
) {
  const { run } = stubRepo({ behind });
  return evaluateGate({
    cwd: "/repo",
    policy: resolveSteeringPolicy([{ scope: "project", policy: file }]),
    run,
    cacheIo: noCache,
    now: () => 1,
    ...over,
  });
}

describe("evaluateGate", () => {
  it("allows a current checkout", async () => {
    const d = await gate(false);
    expect(d.action).toBe("allow");
    expect(d.exitCode).toBe(0);
    expect(d.sync).toBeNull();
  });

  it("warns on a stale checkout when blocking is off", async () => {
    const d = await gate(true);
    // Named first so a stub the check has outgrown fails on the verdict it
    // produced (`unknown`, with the git command it could not answer in
    // `notes`) rather than on the action that followed from it.
    expect(d.verdict.notes).toEqual([]);
    expect(d.verdict.status).toBe("behind");
    expect(d.action).toBe("warn");
    // A warning still lets the prompt through.
    expect(d.exitCode).toBe(0);
  });

  it("blocks on a stale checkout when blocking is on", async () => {
    const d = await gate(true, { blockStaleRuns: true });
    expect(d.action).toBe("block");
    expect(d.exitCode).toBe(2);
  });

  it("never blocks on an unknown verdict", async () => {
    const run: GitRunner = async () => {
      throw new Error("git is not installed");
    };
    const d = await gate(true, { blockStaleRuns: true }, { run });
    expect(d.verdict.status).toBe("unknown");
    expect(d.action).toBe("allow");
    expect(d.exitCode).toBe(0);
  });

  // Finding 3, at the level that matters: a local git command running out of
  // its 250 ms slice must never become a refusal. The presence probe in the
  // platform fallback was the one place a killed command still produced a
  // definite answer, and `behind` plus `blockStaleRuns` is exit 2.
  it("never blocks when the presence probe is killed by its timeout", async () => {
    const PROMOTION = "4444444444444444444444444444444444444444";
    const { run: base } = stubRepo({ behind: false });
    const run: GitRunner = async (args, opts) => {
      if (args[0] === "cat-file") {
        throw new GitCommandError([...args], null, "", "SIGTERM");
      }
      return base(args, opts);
    };
    const d = await gate(
      false,
      { blockStaleRuns: true },
      {
        run,
        platform: {
          steeringVersion: 42,
          headCommit: PROMOTION,
          aheadOfCheckout: true,
        },
      },
    );
    expect(d.verdict.status).toBe("unknown");
    expect(d.action).not.toBe("block");
    expect(d.exitCode).toBe(0);
  });

  it("does not block while the escape hatch is set", async () => {
    const { run } = stubRepo({ behind: true });
    const d = await evaluateGate({
      cwd: "/repo",
      policy: resolveSteeringPolicy(
        [{ scope: "workspace", policy: { blockStaleRuns: true } }],
        { suspended: true, reason: "OXAGEN_STEERING_FRESHNESS=off" },
      ),
      run,
      cacheIo: noCache,
      now: () => 1,
    });
    expect(d.action).toBe("warn");
    expect(d.exitCode).toBe(0);
  });
});

/**
 * The committed gates are read from a remote-tracking ref, and the check
 * inside the gate is what moves that ref. Production publishing new records
 * and `blockStaleRuns: true` in one merge was therefore read at its old value
 * on the very prompt the new records arrived: the gate saw them as behind and
 * only warned, and enforcement started one prompt later.
 */
describe("evaluateGate with a reloaded policy", () => {
  const blocking = resolveSteeringPolicy([
    { scope: "project", policy: { blockStaleRuns: true } },
  ]);

  it("enforces a gate the fetch it just made published", async () => {
    const d = await gate(true, {}, { reloadPolicy: async () => blocking });
    expect(d.verdict.fetch).toEqual({ attempted: true, ok: true, reason: null });
    expect(d.policy.blockStaleRuns).toBe(true);
    expect(d.policy.sources.blockStaleRuns).toBe("project");
    expect(d.action).toBe("block");
    expect(d.exitCode).toBe(2);
  });

  // The fold is a ratchet in every other direction; a reload is no exception.
  it("does not let the reload switch a gate back off", async () => {
    const d = await gate(
      true,
      { blockStaleRuns: true },
      { reloadPolicy: async () => resolveSteeringPolicy([]) },
    );
    expect(d.policy.blockStaleRuns).toBe(true);
    expect(d.action).toBe("block");
  });

  // Auto-sync is read after the reload, so a newly published `autoSync` acts
  // on the same prompt rather than on the next one.
  it("runs a sync the reload turned on", async () => {
    const d = await gate(
      true,
      {},
      {
        reloadPolicy: async () =>
          resolveSteeringPolicy([
            { scope: "project", policy: { autoSync: true } },
          ]),
      },
    );
    expect(d.sync?.applied).toBe(true);
    expect(d.verdict.status).toBe("current");
    expect(d.action).toBe("allow");
  });

  // Every prompt pays for this, so it only runs when the ref can have moved.
  it("does not reload when the check was not allowed to fetch", async () => {
    const reloadPolicy = vi.fn(async () => blocking);
    const d = await gate(true, {}, { allowNetwork: false, reloadPolicy });
    expect(d.verdict.fetch.attempted).toBe(false);
    expect(reloadPolicy).not.toHaveBeenCalled();
    expect(d.action).toBe("warn");
  });

  // A current checkout is allowed whatever the gates say, so reading them
  // again would be a `git show` in front of every prompt for nothing.
  it("does not reload on a checkout that is already current", async () => {
    const reloadPolicy = vi.fn(async () => blocking);
    const d = await gate(false, {}, { reloadPolicy });
    expect(reloadPolicy).not.toHaveBeenCalled();
    expect(d.action).toBe("allow");
  });

  it("does not reload when the fetch failed", async () => {
    const { run } = stubRepo({ behind: true });
    const unreachable: GitRunner = async (args, opts) => {
      if (args[0] === "fetch") throw new Error("could not resolve host");
      return run(args, opts);
    };
    const reloadPolicy = vi.fn(async () => blocking);
    const d = await gate(true, {}, { run: unreachable, reloadPolicy });
    expect(d.verdict.fetch.ok).toBe(false);
    expect(reloadPolicy).not.toHaveBeenCalled();
  });

  // A read that can only ever tighten must not become a way past a gate that
  // was already on: the CLI's catch-all exits 0, so a rejection here would
  // have allowed the prompt.
  it("keeps the gate it already had when the reload throws", async () => {
    const d = await gate(
      true,
      { blockStaleRuns: true },
      {
        reloadPolicy: async () => {
          throw new Error("git show failed");
        },
      },
    );
    expect(d.action).toBe("block");
    expect(d.exitCode).toBe(2);
  });
});

describe("evaluateGate with auto-sync", () => {
  // The two switches are one behaviour: auto-sync exists so the blocking one
  // rarely fires, which only works if the sync runs before the decision.
  it("syncs, then allows, rather than blocking a problem it just fixed", async () => {
    const d = await gate(true, { autoSync: true, blockStaleRuns: true });
    expect(d.sync?.applied).toBe(true);
    expect(d.verdict.status).toBe("current");
    expect(d.action).toBe("allow");
  });

  it("blocks when the sync refused", async () => {
    const { run } = stubRepo({ behind: true });
    const dirty: GitRunner = async (args, opts) =>
      args.join(" ").startsWith("status --porcelain")
        ? " M .oxagen/rules/ctx.mine.toml\0"
        : run(args, opts);
    const d = await evaluateGate({
      cwd: "/repo",
      policy: resolveSteeringPolicy([
        { scope: "project", policy: { autoSync: true, blockStaleRuns: true } },
      ]),
      run: dirty,
      cacheIo: noCache,
      now: () => 1,
    });
    expect(d.sync?.applied).toBe(false);
    expect(d.sync?.refusal).toBe("dirty");
    expect(d.action).toBe("block");
  });

  // A sync that throws is a sync that did not happen. Letting the rejection
  // escape reached the CLI's catch-all, which exits 0, so turning `autoSync`
  // on let a checkout known to be stale walk past `blockStaleRuns`.
  it("still blocks when the sync itself throws", async () => {
    const { run } = stubRepo({ behind: true });
    const locked: GitRunner = async (args, opts) => {
      if (args[0] === "restore")
        throw new Error("fatal: Unable to create '.git/index.lock'");
      return run(args, opts);
    };
    const d = await evaluateGate({
      cwd: "/repo",
      policy: resolveSteeringPolicy([
        { scope: "project", policy: { autoSync: true, blockStaleRuns: true } },
      ]),
      run: locked,
      cacheIo: noCache,
      now: () => 1,
    });
    expect(d.sync?.applied).toBe(false);
    expect(d.sync?.message).toContain("index.lock");
    expect(d.action).toBe("block");
    expect(d.exitCode).toBe(2);
  });

  // Finding 1. The sync's own default is 30 seconds per git call, one and a
  // half times the hook's whole timeout, and the gate used to pass it no
  // deadline at all: a slow `restore`, `rm` or `clean` let the harness kill
  // the process before the decision was rendered, and the prompt ran with
  // `blockStaleRuns` on. Every call the sync makes is now clamped to what is
  // left of the gate's own budget.
  it("hands the sync what is left of the hook's budget", async () => {
    const { run: base } = stubRepo({ behind: true });
    const seen: number[] = [];
    const run: GitRunner = async (args, opts) => {
      if (args[0] === "restore") seen.push(opts.timeoutMs);
      return base(args, opts);
    };
    const d = await evaluateGate({
      cwd: "/repo",
      policy: resolveSteeringPolicy([
        { scope: "project", policy: { autoSync: true, blockStaleRuns: true } },
      ]),
      run,
      cacheIo: noCache,
      now: () => 1,
      timeoutMs: 30_000,
      hookBudgetMs: 6_000,
    });
    expect(d.sync?.applied).toBe(true);
    expect(seen).toEqual([6_000]);
  });

  // And when the check has already spent the hook's time, the sync does not
  // start. Nothing is written, `applied` is false, and the blocking policy
  // still refuses the prompt: the one outcome that must not happen is a
  // half-written `.oxagen/` plus a prompt that ran anyway.
  it("refuses the sync, and still blocks, when the budget is gone", async () => {
    let clock = 1_000_000;
    const { run: base } = stubRepo({ behind: true });
    const run: GitRunner = async (args, opts) => {
      // The check itself spends the whole budget.
      if (args[0] === "status") clock += 7_000;
      return base(args, opts);
    };
    const d = await evaluateGate({
      cwd: "/repo",
      policy: resolveSteeringPolicy([
        { scope: "project", policy: { autoSync: true, blockStaleRuns: true } },
      ]),
      run,
      cacheIo: noCache,
      now: () => clock,
      hookBudgetMs: 6_000,
    });
    expect(d.sync?.applied).toBe(false);
    expect(d.sync?.refusal).toBe("out_of_time");
    expect(d.action).toBe("block");
    expect(d.exitCode).toBe(2);
  });

  it("does not sync when the caller asked to look only", async () => {
    const { run, state } = stubRepo({ behind: true });
    const d = await evaluateGate({
      cwd: "/repo",
      policy: resolveSteeringPolicy([
        { scope: "project", policy: { autoSync: true } },
      ]),
      run,
      cacheIo: noCache,
      now: () => 1,
      readOnly: true,
    });
    expect(d.sync).toBeNull();
    expect(state.behind).toBe(true);
  });

  it("does not sync a checkout that is already current", async () => {
    const { run } = stubRepo({ behind: false });
    const spy = vi.fn(run);
    await evaluateGate({
      cwd: "/repo",
      policy: resolveSteeringPolicy([
        { scope: "project", policy: { autoSync: true } },
      ]),
      run: spy,
      cacheIo: noCache,
      now: () => 1,
    });
    expect(spy.mock.calls.some(([args]) => args[0] === "restore")).toBe(false);
  });
});
