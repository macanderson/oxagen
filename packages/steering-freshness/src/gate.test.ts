import { describe, expect, it, vi } from "vitest";
import { evaluateGate } from "./gate";
import { resolveSteeringPolicy } from "./policy";
import type { CacheIo } from "./cache";
import type { GitRunner } from "./git";

const HEAD = "1111111111111111111111111111111111111111";
const REMOTE = "2222222222222222222222222222222222222222";
const BASE = "3333333333333333333333333333333333333333";
const EXCL = ":(exclude).oxagen/settings.local.json";

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
      case "rev-parse --verify --quiet origin/main^{commit}":
        return REMOTE;
      case `merge-base ${HEAD} ${REMOTE}`:
        return BASE;
      case `diff --name-status --no-renames -z ${BASE} ${REMOTE} -- .oxagen ${EXCL}`:
        return state.behind ? "A\0.oxagen/rules/ctx.a.toml\0" : "";
      case `diff --name-status --no-renames -z ${BASE} ${HEAD} -- .oxagen ${EXCL}`:
        return "";
      case `status --porcelain=v1 -z --untracked-files=normal -- .oxagen ${EXCL}`:
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
