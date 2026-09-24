/**
 * `oxagen steering …` — pins the four properties the harness contract rests
 * on: the gate never throws and never exits non-zero except to refuse, the
 * platform call is optional in every failure mode, a refused sync is not
 * reported as success, and the harness renderers reach stdout unaltered.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  apiPostOrThrow,
  evaluateGate,
  checkSteeringFreshness,
  syncSteering,
  execGit,
} = vi.hoisted(() => ({
  apiPostOrThrow:
    vi.fn<
      (
        path: string,
        body: unknown,
        scope?: { org: string; ws: string },
        options?: { timeoutMs?: number },
      ) => Promise<unknown>
    >(),
  evaluateGate: vi.fn(),
  checkSteeringFreshness: vi.fn(),
  syncSteering: vi.fn(),
  // The CLI must never reach a real git in a unit test. Hoisted so a test can
  // say what `git remote get-url` answered, which is how the checkout's own
  // repository is identified.
  execGit: vi.fn<(args: readonly string[]) => Promise<string>>(),
}));

const { userApiPostOrThrow, MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    readonly status: number;
    constructor(message: string, status = 0) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }
  return {
    userApiPostOrThrow:
      vi.fn<
        (
          path: string,
          body: unknown,
          options?: { timeoutMs?: number },
        ) => Promise<unknown>
      >(),
    MockApiError,
  };
});

vi.mock("../lib/api.js", () => ({
  apiPostOrThrow,
  userApiPostOrThrow,
  ApiError: MockApiError,
}));

vi.mock("@oxagen/steering-freshness", async () => {
  const actual = await vi.importActual<
    typeof import("@oxagen/steering-freshness")
  >("@oxagen/steering-freshness");
  return {
    ...actual,
    evaluateGate,
    checkSteeringFreshness,
    syncSteering,
    execGit,
  };
});

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { captureWriter, type CommandWriter } from "../lib/capture-writer";
import {
  budgetFrom,
  findProjectRoot,
  toSignal,
  parseRemoteUrl,
  resolveContext,
  steeringGate,
  steeringHooks,
  steeringStatus,
  steeringSync,
  HOOK_PATH_BUDGET_MS,
} from "./steering";
import {
  resolveSteeringPolicy,
  DEFAULT_NETWORK_BUDGET_MS,
  HOOK_TIMEOUT_SECONDS,
} from "@oxagen/steering-freshness";
import {
  mkdtemp,
  realpath,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `captureWriter` folds stdout and stderr into one buffer, and the gate's
 * whole contract is that they are different channels: stdout belongs to the
 * harness, stderr carries the banner. So the gate tests keep them apart.
 */
function splitWriter(): {
  writer: CommandWriter;
  out: () => string;
  err: () => string;
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    writer: {
      write: (line) => {
        out.push(line);
      },
      writeErr: (line) => {
        err.push(line);
      },
    },
    out: () => out.join("\n"),
    err: () => err.join("\n"),
  };
}

const verdict = {
  status: "behind" as const,
  remote: "origin",
  branch: "main",
  missing: [{ status: "added" as const, path: ".oxagen/rules/ctx.a.toml" }],
  local: [],
  dirty: [],
  behindByCommits: 1,
  fingerprint: { local: "a", remote: "b" },
  fetch: { attempted: true, ok: true, reason: null },
  notes: [],
  platform: null,
};

/**
 * Answer `git remote` and `git remote get-url <name>` from a table of remotes,
 * the two calls the CLI makes to identify which remote is the bound
 * repository. Anything else answers empty.
 */
function remotes(table: Record<string, string>): void {
  execGit.mockImplementation(async (args: readonly string[]) => {
    if (args.length === 1 && args[0] === "remote")
      return Object.keys(table).join("\n");
    if (args[0] === "remote" && args[1] === "get-url")
      return table[args[args.length - 1] ?? ""] ?? "";
    return "";
  });
}

/**
 * `remotes`, plus the blobs `git show <ref>:<path>` can answer. A spec with no
 * blob fails the way git does, which is how the committed-gates read learns
 * the production branch has no settings file. The specs it was asked for are
 * returned, because which ref is read is the property under test.
 */
function gitStub({
  remotes: table,
  blobs,
}: {
  remotes: Record<string, string>;
  blobs: Record<string, string>;
}): { specs: string[] } {
  const specs: string[] = [];
  execGit.mockImplementation(async (args: readonly string[]) => {
    if (args.length === 1 && args[0] === "remote")
      return Object.keys(table).join("\n");
    if (args[0] === "remote" && args[1] === "get-url")
      return table[args[args.length - 1] ?? ""] ?? "";
    if (args[0] === "show") {
      const spec = args[1] ?? "";
      specs.push(spec);
      const blob = blobs[spec];
      if (blob === undefined)
        throw new Error(`fatal: path does not exist: ${spec}`);
      return blob;
    }
    return "";
  });
  return { specs };
}

beforeEach(() => {
  process.exitCode = undefined;
  apiPostOrThrow.mockReset();
  apiPostOrThrow.mockRejectedValue(new Error("no platform in tests"));
  checkSteeringFreshness.mockReset();
  checkSteeringFreshness.mockResolvedValue(verdict);
  evaluateGate.mockReset();
  syncSteering.mockReset();
  execGit.mockReset();
  execGit.mockResolvedValue("");
  userApiPostOrThrow.mockReset();
  userApiPostOrThrow.mockRejectedValue(new Error("no lists in tests"));
});

describe("findProjectRoot", () => {
  it("walks up to the directory holding .oxagen", async () => {
    // Real path: the walk compares against git's answer, which is one.
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "oxagen-cli-")));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    await mkdir(join(tmp, "packages", "deep"), { recursive: true });
    expect(findProjectRoot(join(tmp, "packages", "deep"))).toBe(tmp);
  });

  // Outside any repository there is nothing better than where we started.
  it("falls back to the starting directory outside a repository", async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "oxagen-cli-")));
    expect(findProjectRoot(tmp)).toBe(tmp);
  });

  // A branch cut before the repository's first `.oxagen/` has none above the
  // prompt's directory. Anchoring at that subdirectory made the sync's
  // root-relative `git restore` match nothing, throw, and let the gate allow
  // the prompt with `blockStaleRuns` on.
  // A nested repository or a submodule is a different repository. Walking past
  // its root found the OUTER checkout's `.oxagen/`, and the gate then governed
  // the wrong one.
  it("does not climb out of a nested repository to an outer .oxagen", async () => {
    const outer = await realpath(await mkdtemp(join(tmpdir(), "oxagen-cli-")));
    await mkdir(join(outer, ".oxagen"), { recursive: true });
    const inner = join(outer, "vendor", "lib");
    await mkdir(inner, { recursive: true });
    await promisify(execFile)("git", ["init", "--quiet"], { cwd: inner });
    const deep = join(inner, "src");
    await mkdir(deep, { recursive: true });
    expect(findProjectRoot(deep)).toBe(inner);
  });

  // A second `.oxagen/` below the repository root (a vendored copy, a
  // fixture, a second project in one checkout) was found first by the walk,
  // and the gate read that workspace link and policy while every git
  // comparison stayed pinned to the repository root.
  it("ignores a nested .oxagen inside the same repository", async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "oxagen-cli-")));
    await promisify(execFile)("git", ["init", "--quiet"], { cwd: tmp });
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    const nested = join(tmp, "fixtures", "project");
    await mkdir(join(nested, ".oxagen"), { recursive: true });
    expect(findProjectRoot(nested)).toBe(tmp);
  });

  it("falls back to the repository root, not the subdirectory, inside a repository", async () => {
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "oxagen-cli-")));
    await promisify(execFile)("git", ["init", "--quiet"], { cwd: tmp });
    const deep = join(tmp, "packages", "deep");
    await mkdir(deep, { recursive: true });
    expect(findProjectRoot(deep)).toBe(tmp);
  });
});

// Each ancestry call had its own five seconds, so two commits published in
// one second could spend ten before the freshness check began its own budget,
// past the twenty the harness gives the hook: it killed the gate and the
// prompt ran with blockStaleRuns on.
describe("toSignal ancestry budget", () => {
  it("shares one deadline across every published commit", async () => {
    let clock = 0;
    const timeouts: number[] = [];
    execGit.mockImplementation((async (
      _args: readonly string[],
      opts: { timeoutMs: number },
    ) => {
      timeouts.push(opts.timeoutMs);
      // Each call burns three seconds of the five-second budget.
      clock += 3_000;
      return "";
    }) as never);
    const signal = await toSignal(
      {
        steeringVersion: 4,
        headCommit: "c1",
        headCommits: ["c1", "c2", "c3"],
        repository: "acme/platform",
        defaultBranch: "main",
        policy: null,
      } as never,
      "/repo",
      () => clock,
    );
    // The first call gets the whole budget, the second what is left, and the
    // third never runs because there is none.
    expect(timeouts).toEqual([5_000, 2_000]);
    // A commit the gate could not check is not one the checkout reaches.
    expect(signal?.aheadOfCheckout).toBe(true);
  });

  it("reports current when every commit is reachable inside the budget", async () => {
    execGit.mockImplementation((async () => "") as never);
    const signal = await toSignal(
      {
        steeringVersion: 4,
        headCommit: "c1",
        headCommits: ["c1", "c2"],
        repository: "acme/platform",
        defaultBranch: "main",
        policy: null,
      } as never,
      "/repo",
      () => 0,
    );
    expect(signal?.aheadOfCheckout).toBe(false);
  });
});

// Every stage of the gate carried its own constant and the hook paid the
// sum: three seconds reading the platform, five reading the committed gates,
// five in `toSignal`, eight in the freshness check and five more reloading
// the policy after the fetch. Twenty-six seconds, past the twenty the hook
// allows, so the harness killed the gate and the prompt ran unenforced.
describe("the gate's shared budget", () => {
  it("leaves the installed hook room to finish", () => {
    expect(HOOK_PATH_BUDGET_MS).toBeLessThan(HOOK_TIMEOUT_SECONDS * 1_000);
    expect(HOOK_PATH_BUDGET_MS).toBeGreaterThan(0);
  });

  it("caps a stage at what is left, and floors a late one so it still runs", () => {
    let clock = 0;
    const budget = budgetFrom(10_000, () => clock);
    // Early: the stage's own cap is the smaller of the two.
    expect(budget.stage(3_000).remaining()).toBe(3_000);
    // Late: what is left is.
    clock = 8_000;
    expect(budget.stage(5_000).remaining()).toBe(2_000);
    // Spent: a slice small enough to fail fast, large enough for a local git
    // call that is about to answer.
    clock = 12_000;
    expect(budget.expired()).toBe(true);
    expect(budget.stage(5_000).remaining()).toBe(250);
  });

  it("spends one budget across the platform read, the remote lookup and the committed gates", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    let clock = 0;
    const asked: number[] = [];
    apiPostOrThrow.mockImplementation(async (_path, _body, _scope, options) => {
      asked.push(options?.timeoutMs ?? 0);
      clock += 3_000;
      return {
        steeringVersion: 1,
        headCommit: null,
        repository: "acme/app",
        defaultBranch: "main",
        policy: null,
      };
    });
    const gitTimeouts: number[] = [];
    execGit.mockImplementation((async (
      args: readonly string[],
      opts: { timeoutMs: number },
    ) => {
      gitTimeouts.push(opts.timeoutMs);
      clock += 2_000;
      if (args.length === 1 && args[0] === "remote") return "origin";
      if (args[0] === "remote" && args[1] === "get-url")
        return "git@github.com:acme/app.git";
      return "";
    }) as never);

    const ctx = await resolveContext(tmp, {
      budget: budgetFrom(10_000, () => clock),
    });

    // The platform read gets its own three-second cap, because the budget is
    // untouched at that point.
    expect(asked).toEqual([3_000]);
    // `git remote` at 3s has seven of the ten left, so its five-second cap
    // binds; `git remote get-url` at 5s gets the three the lookup stage has
    // left; the committed-gates read starts at 7s and gets three rather than
    // another five.
    expect(gitTimeouts).toEqual([5_000, 3_000, 3_000]);
    // The lookup matched inside its slice, so nothing is reported as
    // belonging elsewhere and the budget is not reported as spent.
    expect(ctx.warnings.join("\n")).not.toContain("no remote of this checkout");
    expect(ctx.warnings.join("\n")).not.toContain("ran out of");
  });

  it("says so when the budget runs out, and does not blame the checkout's remotes", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    let clock = 0;
    apiPostOrThrow.mockImplementation(async () => {
      clock += 3_000;
      return {
        steeringVersion: 1,
        headCommit: null,
        repository: "acme/app",
        defaultBranch: "main",
        policy: null,
      };
    });
    execGit.mockImplementation((async (args: readonly string[]) => {
      clock += 2_000;
      if (args.length === 1 && args[0] === "remote") return "origin";
      return "";
    }) as never);

    const ctx = await resolveContext(tmp, {
      budget: budgetFrom(4_000, () => clock),
    });

    // The remote that matches may well be there; the search ran out before it
    // could say. Telling the developer to relink would send them to fix the
    // wrong thing.
    expect(ctx.warnings.join("\n")).toContain(
      "ran out of time before it could tell whether a remote",
    );
    expect(ctx.warnings.join("\n")).not.toContain("oxagen init");
    expect(ctx.warnings.join("\n")).toContain("ran out of its");
    // The platform answer goes with it, so git stays the only signal.
    expect(ctx.platform).toBeNull();
  });
});

describe("resolveContext", () => {
  it("carries on when the platform cannot be reached", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    const ctx = await resolveContext(tmp);
    expect(ctx.platform).toBeNull();
    expect(ctx.policy.blockStaleRuns).toBe(false);
  });

  it("takes the workspace policy from the platform, above every file", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    await writeFile(
      join(tmp, ".oxagen", "settings.local.json"),
      JSON.stringify({ steering: { blockStaleRuns: false } }),
      "utf8",
    );
    remotes({ origin: "git@github.com:acme/app.git" });
    apiPostOrThrow.mockResolvedValue({
      steeringVersion: 7,
      headCommit: null,
      repository: "acme/app",
      defaultBranch: "main",
      policy: { blockStaleRuns: true },
    });
    const ctx = await resolveContext(tmp);
    // The personal file said false. It cannot switch the workspace gate off.
    expect(ctx.policy.blockStaleRuns).toBe(true);
    expect(ctx.policy.sources.blockStaleRuns).toBe("workspace");
    expect(ctx.platform?.steeringVersion).toBe(7);
  });

  it("never calls the platform when offline", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    await resolveContext(tmp, { offline: true });
    expect(apiPostOrThrow).not.toHaveBeenCalled();
  });

  // The call is scoped by the CLI's globally selected workspace, not by the
  // directory the prompt came from, and a developer with several checkouts
  // routinely has one selected while working in another. Inheriting that
  // workspace's blocking policy refused prompts over records belonging to a
  // repository this checkout has nothing to do with.
  it("ignores a platform answer about a different repository", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    remotes({ origin: "git@github.com:acme/this-one.git" });
    apiPostOrThrow.mockResolvedValue({
      steeringVersion: 7,
      headCommit: null,
      repository: "acme/some-other",
      defaultBranch: "main",
      policy: { blockStaleRuns: true },
    });
    const ctx = await resolveContext(tmp);
    expect(ctx.platform).toBeNull();
    expect(ctx.policy.blockStaleRuns).toBe(false);
    expect(ctx.warnings.join(" ")).toContain("acme/some-other");
  });

  it("keeps the answer when the repository matches, whatever the URL shape", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    remotes({ origin: "https://github.com/Acme/This-One.git" });
    apiPostOrThrow.mockResolvedValue({
      steeringVersion: 7,
      headCommit: null,
      repository: "acme/this-one",
      defaultBranch: "main",
      policy: { blockStaleRuns: true },
    });
    const ctx = await resolveContext(tmp);
    expect(ctx.platform?.steeringVersion).toBe(7);
    expect(ctx.policy.blockStaleRuns).toBe(true);
  });

  // The team committed `blockStaleRuns: true`. The developer typed `false`
  // into the working copy and committed nothing. The production branch's
  // copy still counts.
  it("keeps a gate the production branch committed when the working copy switches it off", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    await writeFile(
      join(tmp, ".oxagen", "settings.json"),
      JSON.stringify({ steering: { blockStaleRuns: false } }),
    );
    execGit.mockImplementation(async (args: readonly string[]) =>
      args[0] === "show" &&
      args[1] === "refs/remotes/origin/HEAD:.oxagen/settings.json"
        ? JSON.stringify({ steering: { blockStaleRuns: true } })
        : "",
    );
    const ctx = await resolveContext(tmp);
    expect(ctx.policy.blockStaleRuns).toBe(true);
    expect(ctx.policy.sources.blockStaleRuns).toBe("project");
  });

  // Two Context PRs merged inside one second, so the platform names both
  // commits without ordering them. HEAD holds the first and lacks the second.
  it("reads the checkout as behind the platform when HEAD lacks one of the tied commits", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    execGit.mockImplementation(async (args: readonly string[]) => {
      if (args.length === 1 && args[0] === "remote") return "origin";
      if (args[0] === "remote" && args[1] === "get-url")
        return "https://github.com/acme/this-one.git";
      if (args[0] === "merge-base" && args[2] === "held") return "";
      if (args[0] === "merge-base") throw new Error("exit 1");
      return "";
    });
    apiPostOrThrow.mockResolvedValue({
      steeringVersion: 8,
      headCommit: "held",
      headCommits: ["held", "missing"],
      repository: "acme/this-one",
      defaultBranch: "main",
      policy: { blockStaleRuns: true },
    });
    const ctx = await resolveContext(tmp);
    expect(ctx.platform?.aheadOfCheckout).toBe(true);
    expect(ctx.platform?.headCommits).toEqual(["held", "missing"]);

    // One commit named, and HEAD holds it: not behind.
    apiPostOrThrow.mockResolvedValue({
      steeringVersion: 8,
      headCommit: "held",
      headCommits: ["held"],
      repository: "acme/this-one",
      defaultBranch: "main",
      policy: { blockStaleRuns: true },
    });
    expect((await resolveContext(tmp)).platform?.aheadOfCheckout).toBe(false);
  });

  // The workspace approved `release`; the remote's own default is still
  // `main`. Comparing against `main` left an enforced checkout reported as
  // `current` while Context PRs merged into `release`.
  it("compares against the workspace's approved branch, not the remote's default", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    await writeFile(
      join(tmp, ".oxagen", "settings.local.json"),
      JSON.stringify({ steering: { branch: "main" } }),
      "utf8",
    );
    remotes({ origin: "git@github.com:acme/app.git" });
    apiPostOrThrow.mockResolvedValue({
      steeringVersion: 7,
      headCommit: null,
      repository: "acme/app",
      defaultBranch: "release",
      policy: { blockStaleRuns: true },
    });
    const ctx = await resolveContext(tmp);
    // `workspace` is the last scope, so it outranks the personal file too.
    expect(ctx.policy.branch).toBe("release");
  });

  // Two workspaces can bind the same repository, and then a repository-name
  // check passes for both. The checkout's own link is what tells them apart.
  it("asks the workspace the checkout is linked to, not the global selection", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    await writeFile(
      join(tmp, ".oxagen", "workspace.json"),
      JSON.stringify({ orgSlug: "acme", workspaceSlug: "payments" }),
      "utf8",
    );
    await resolveContext(tmp);
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "context/steering/freshness",
      {},
      { org: "acme", ws: "payments" },
      expect.anything(),
    );
  });

  // The link names the workspace by slug. An org or workspace renamed after
  // `oxagen init` answered 404 for every linked checkout, and the workspace's
  // gates were dropped until somebody relinked. The ids in the link do not
  // change, so they resolve to today's slugs and the link is rewritten.
  it("follows a renamed org or workspace through the ids in the link", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    await writeFile(
      join(tmp, ".oxagen", "workspace.json"),
      JSON.stringify({
        orgSlug: "acme-old",
        orgId: "org_1",
        workspaceSlug: "payments-old",
        workspaceId: "ws_1",
      }),
      "utf8",
    );
    remotes({ origin: "git@github.com:acme/app.git" });
    apiPostOrThrow.mockImplementation(async (_path, _body, scope) => {
      const s = scope as { org: string; ws: string } | undefined;
      if (s?.org === "acme" && s.ws === "payments")
        return {
          steeringVersion: 9,
          headCommit: null,
          repository: "acme/app",
          defaultBranch: "main",
          policy: { blockStaleRuns: true },
        };
      throw new MockApiError("not found", 404);
    });
    userApiPostOrThrow.mockImplementation(async (path) => {
      if (path === "organizations")
        return { organizations: [{ id: "org_1", slug: "acme" }] };
      if (path === "workspaces")
        return { workspaces: [{ id: "ws_1", slug: "payments" }] };
      throw new Error(`unexpected ${path}`);
    });

    const ctx = await resolveContext(tmp);
    expect(ctx.platform?.steeringVersion).toBe(9);
    expect(ctx.policy.blockStaleRuns).toBe(true);
    // The link now carries today's slugs, so the next prompt is direct.
    const rewritten = JSON.parse(
      await readFile(join(tmp, ".oxagen", "workspace.json"), "utf8"),
    ) as { orgSlug: string; workspaceSlug: string };
    expect(rewritten).toMatchObject({
      orgSlug: "acme",
      workspaceSlug: "payments",
    });
  });

  // The Organization page shows only public ids, so a link written by hand
  // from it carries `org_…` and `wrk_…` rather than database ids. Those must
  // find the renamed records too, and must not match a record whose database
  // id happens to be absent from the answer.
  it("follows a renamed org or workspace through public ids in the link", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    await writeFile(
      join(tmp, ".oxagen", "workspace.json"),
      JSON.stringify({
        orgSlug: "acme-old",
        orgId: "org_8fK2mQ9xLw3RtY6bN1pZ4c",
        workspaceSlug: "payments-old",
        workspaceId: "wrk_3Hs7Vd1QkP9mXe2Lt5Ga8r",
      }),
      "utf8",
    );
    remotes({ origin: "git@github.com:acme/app.git" });
    apiPostOrThrow.mockImplementation(async (_path, _body, scope) => {
      const s = scope as { org: string; ws: string } | undefined;
      if (s?.org === "acme" && s.ws === "payments")
        return {
          steeringVersion: 4,
          headCommit: null,
          repository: "acme/app",
          defaultBranch: "main",
          policy: { blockStaleRuns: true },
        };
      throw new MockApiError("not found", 404);
    });
    userApiPostOrThrow.mockImplementation(async (path, body) => {
      if (path === "organizations")
        return {
          organizations: [
            {
              id: "3c9bd760-d44a-4891-a4a5-35878d4fcfaa",
              publicId: "org_0other",
              slug: "other",
            },
            {
              id: "0d6f1b2e-7a55-4a47-9c1c-2f1f0f6b8a10",
              publicId: "org_8fK2mQ9xLw3RtY6bN1pZ4c",
              slug: "acme",
            },
          ],
        };
      if (path === "workspaces") {
        expect(body).toEqual({ orgSlug: "acme" });
        return {
          workspaces: [
            {
              id: "778d509d-ea0b-4f1a-be73-d1d7fb5f97df",
              publicId: "wrk_3Hs7Vd1QkP9mXe2Lt5Ga8r",
              slug: "payments",
            },
          ],
        };
      }
      throw new Error(`unexpected ${path}`);
    });

    const ctx = await resolveContext(tmp);
    expect(ctx.platform?.steeringVersion).toBe(4);
    const rewritten = JSON.parse(
      await readFile(join(tmp, ".oxagen", "workspace.json"), "utf8"),
    ) as Record<string, string>;
    expect(rewritten).toMatchObject({
      orgSlug: "acme",
      orgId: "org_8fK2mQ9xLw3RtY6bN1pZ4c",
      workspaceSlug: "payments",
      workspaceId: "wrk_3Hs7Vd1QkP9mXe2Lt5Ga8r",
    });
  });

  // A hand-written link may leave the ids out. Recovery then has nothing to
  // match on and must not pick a record by accident.
  it("does not recover a link that carries no ids", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    await writeFile(
      join(tmp, ".oxagen", "workspace.json"),
      JSON.stringify({ orgSlug: "acme-old", workspaceSlug: "payments-old" }),
      "utf8",
    );
    apiPostOrThrow.mockRejectedValue(new MockApiError("not found", 404));
    userApiPostOrThrow.mockResolvedValue({
      organizations: [{ id: "x", publicId: "org_x", slug: "acme" }],
    });
    const ctx = await resolveContext(tmp);
    expect(ctx.platform).toBeNull();
    expect(userApiPostOrThrow).not.toHaveBeenCalled();
  });

  // Records shaped as `list_organizations` and `list_workspaces` return them,
  // with both forms of id. Each list leads with a decoy, so a finder that took
  // the first record, or fell back to the only one, lands on the wrong
  // workspace and applies its gates to this checkout.
  const ACME = {
    id: "0d6f1b2e-7a55-4a47-9c1c-2f1f0f6b8a10",
    publicId: "org_8fK2mQ9xLw3RtY6bN1pZ4c",
    slug: "acme",
  };
  const OTHER_ORG = {
    id: "3c9bd760-d44a-4891-a4a5-35878d4fcfaa",
    publicId: "org_5nW1cE8tRk2Yh7Qz4Lp9Vd",
    slug: "other",
  };
  const PAYMENTS = {
    id: "778d509d-ea0b-4f1a-be73-d1d7fb5f97df",
    publicId: "wrk_3Hs7Vd1QkP9mXe2Lt5Ga8r",
    slug: "payments",
  };
  const BILLING = {
    id: "5a2e9c41-0b7d-4f3e-8a61-c94d2b7e1f08",
    publicId: "wrk_6Jd2Nx8Rw4Kc1Tm9Hq3Bz7",
    slug: "billing",
  };

  /**
   * A checkout whose link carries old slugs and the given ids, a platform
   * that answers only acme/payments and 404s every other scope, and lists
   * that answer `organizations` and acme's `workspaces`. Returns the checkout
   * and the link's text as written.
   */
  async function renamedCheckout(
    ids: { orgId?: string; workspaceId?: string },
    lists: {
      organizations: (typeof ACME)[];
      workspaces: (typeof PAYMENTS)[];
    },
  ): Promise<{ tmp: string; written: string }> {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    const written = JSON.stringify({
      orgSlug: "acme-old",
      workspaceSlug: "payments-old",
      ...ids,
    });
    await writeFile(join(tmp, ".oxagen", "workspace.json"), written, "utf8");
    remotes({ origin: "git@github.com:acme/app.git" });
    apiPostOrThrow.mockImplementation(async (_path, _body, scope) => {
      const s = scope as { org: string; ws: string } | undefined;
      if (s?.org === "acme" && s.ws === "payments")
        return {
          steeringVersion: 11,
          headCommit: null,
          repository: "acme/app",
          defaultBranch: "main",
          policy: { blockStaleRuns: true },
        };
      throw new MockApiError("not found", 404);
    });
    userApiPostOrThrow.mockImplementation(async (path, body) => {
      if (path === "organizations")
        return { organizations: lists.organizations };
      if (path === "workspaces") {
        // Another org's workspaces never include payments.
        const { orgSlug } = body as { orgSlug: string };
        return {
          workspaces: orgSlug === "acme" ? lists.workspaces : [BILLING],
        };
      }
      throw new Error(`unexpected ${path}`);
    });
    return { tmp, written };
  }

  /** How many times the freshness read went out, first try and retry. */
  function freshnessReads(): number {
    return apiPostOrThrow.mock.calls.filter(
      ([path]) => path === "context/steering/freshness",
    ).length;
  }

  // `oxagen init` writes database ids, and the Organization page shows public
  // ids, so a person who repoints one field by hand from the page leaves a
  // link holding one form of each. Each id is matched on its own; the link's
  // form is never decided once for both.
  it.each([
    [
      "the org by public id and the workspace by database id",
      ACME.publicId,
      PAYMENTS.id,
    ],
    [
      "the org by database id and the workspace by public id",
      ACME.id,
      PAYMENTS.publicId,
    ],
  ])(
    "follows a renamed link that names %s",
    async (_case, orgId, workspaceId) => {
      const { tmp } = await renamedCheckout(
        { orgId, workspaceId },
        { organizations: [OTHER_ORG, ACME], workspaces: [BILLING, PAYMENTS] },
      );

      const ctx = await resolveContext(tmp);
      expect(ctx.platform?.steeringVersion).toBe(11);
      const rewritten = JSON.parse(
        await readFile(join(tmp, ".oxagen", "workspace.json"), "utf8"),
      ) as Record<string, string>;
      // Today's slugs, and each id kept in the form it was written in.
      expect(rewritten).toMatchObject({
        orgSlug: "acme",
        orgId,
        workspaceSlug: "payments",
        workspaceId,
      });
    },
  );

  // One missing id is enough to stop recovery; the other test leaves out
  // both. A link missing either can never resolve, so reading the lists for
  // it only spends the hook's budget.
  it.each([
    ["its workspace id", { orgId: ACME.publicId }],
    ["its org id", { workspaceId: PAYMENTS.publicId }],
  ])(
    "does not recover a link missing %s, and lists nothing (negative)",
    async (_case, ids) => {
      const { tmp, written } = await renamedCheckout(ids, {
        organizations: [ACME],
        workspaces: [PAYMENTS],
      });

      const ctx = await resolveContext(tmp);
      expect(ctx.platform).toBeNull();
      expect(userApiPostOrThrow).not.toHaveBeenCalled();
      expect(freshnessReads()).toBe(1);
      expect(
        await readFile(join(tmp, ".oxagen", "workspace.json"), "utf8"),
      ).toBe(written);
    },
  );

  // An id the lists do not hold (a deleted workspace, access withdrawn, a
  // typo) resolves to nothing. Each list holds exactly one other record, the
  // case where "use the only one" is most tempting: taking it would apply
  // another workspace's gates to this checkout and write its slugs into the
  // link.
  it.each([
    [
      "org",
      { orgId: "org_2Gm8Tx4Wq1Ln6Rb3Ys9Kc", workspaceId: PAYMENTS.publicId },
      1,
    ],
    [
      "workspace",
      { orgId: ACME.publicId, workspaceId: "wrk_7Pv3Lk9Qd2Xs5Nh1Wz8Tf" },
      2,
    ],
  ])(
    "drops the platform read and keeps the link when its %s id names no record (negative)",
    async (_case, ids, listCalls) => {
      const { tmp, written } = await renamedCheckout(ids, {
        organizations: [ACME],
        workspaces: [PAYMENTS],
      });

      const ctx = await resolveContext(tmp);
      expect(ctx.platform).toBeNull();
      expect(userApiPostOrThrow).toHaveBeenCalledTimes(listCalls);
      expect(freshnessReads()).toBe(1);
      expect(
        await readFile(join(tmp, ".oxagen", "workspace.json"), "utf8"),
      ).toBe(written);
    },
  );

  // The recovery calls run inside the same deadline as the read, so a hung
  // list endpoint cannot spend the hook's budget either.
  it("bounds the slug-recovery calls by the same deadline", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    await writeFile(
      join(tmp, ".oxagen", "workspace.json"),
      JSON.stringify({
        orgSlug: "acme-old",
        orgId: "org_1",
        workspaceSlug: "payments-old",
        workspaceId: "ws_1",
      }),
      "utf8",
    );
    apiPostOrThrow.mockRejectedValue(new MockApiError("not found", 404));
    userApiPostOrThrow.mockResolvedValue({ organizations: [] });
    await resolveContext(tmp);
    const [, , options] = userApiPostOrThrow.mock.calls[0] ?? [];
    expect((options as { timeoutMs?: number } | undefined)?.timeoutMs).toEqual(
      expect.any(Number),
    );
  });

  it("falls back to the global selection when the checkout is not linked", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    await resolveContext(tmp);
    expect(apiPostOrThrow).toHaveBeenCalledWith(
      "context/steering/freshness",
      {},
      undefined,
      expect.anything(),
    );
  });

  // The hook has 20 seconds. A hung connection spent all of it here and the
  // harness then allowed the prompt with no gate at all.
  it("bounds the platform read, so a hung API cannot eat the hook budget", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    await resolveContext(tmp);
    const options = apiPostOrThrow.mock.calls[0]?.[3];
    expect(options?.timeoutMs).toEqual(expect.any(Number));
    expect(options?.timeoutMs ?? Infinity).toBeLessThan(10_000);
  });

  // Validating a hard-coded `origin` while a settings file pointed `remote`
  // at a fork verified one repository and then fetched and synced another.
  it("pins the check to the remote that points at the bound repository", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    await writeFile(
      join(tmp, ".oxagen", "settings.local.json"),
      JSON.stringify({ steering: { remote: "fork" } }),
      "utf8",
    );
    remotes({
      fork: "git@github.com:someone/app.git",
      upstream: "git@github.com:acme/app.git",
    });
    apiPostOrThrow.mockResolvedValue({
      steeringVersion: 7,
      headCommit: null,
      repository: "acme/app",
      defaultBranch: "main",
      policy: { blockStaleRuns: true },
    });
    const ctx = await resolveContext(tmp);
    expect(ctx.policy.remote).toBe("upstream");
    expect(ctx.platform?.steeringVersion).toBe(7);
  });

  // The contract says a null repository means steering is off, and there is
  // no identity to match. Applying the gates anyway blocked or auto-synced an
  // unrelated checkout.
  it("ignores the answer of a workspace with no repository bound", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    remotes({ origin: "git@github.com:acme/app.git" });
    apiPostOrThrow.mockResolvedValue({
      steeringVersion: 7,
      headCommit: null,
      repository: null,
      defaultBranch: null,
      policy: { blockStaleRuns: true, autoSync: true },
    });
    const ctx = await resolveContext(tmp);
    expect(ctx.platform).toBeNull();
    expect(ctx.policy.blockStaleRuns).toBe(false);
    expect(ctx.policy.autoSync).toBe(false);
  });

  // Pointing the link or the global selection at an unbound workspace is a
  // way to leave the workspace's gates behind, so it is reported rather than
  // dropped quietly.
  it("says so when the workspace it asked has no repository bound", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    apiPostOrThrow.mockResolvedValue({
      steeringVersion: 0,
      headCommit: null,
      repository: null,
      defaultBranch: null,
      policy: { blockStaleRuns: true },
    });
    const ctx = await resolveContext(tmp);
    expect(ctx.warnings.join(" ")).toContain("no repository bound");
  });

  // Keeping only `owner/repo` accepted a remote on another host, or a local
  // path, as the workspace's GitHub repository.
  it("does not accept the same owner/repo on another host", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    remotes({
      gl: "git@gitlab.com:acme/app.git",
      local: "/tmp/acme/app",
    });
    apiPostOrThrow.mockResolvedValue({
      steeringVersion: 7,
      headCommit: null,
      repository: "acme/app",
      defaultBranch: "main",
      policy: { blockStaleRuns: true },
    });
    const ctx = await resolveContext(tmp);
    expect(ctx.platform).toBeNull();
    expect(ctx.policy.blockStaleRuns).toBe(false);
  });

  // A GitLab main project (#3762): the platform names its host, and the
  // project may sit in nested groups.
  it("matches a GitLab main project in nested groups against its gitlab.com remote, and nothing on github.com", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    remotes({ origin: "git@gitlab.com:acme/platform/rules.git" });
    apiPostOrThrow.mockResolvedValue({
      steeringVersion: 7,
      headCommit: null,
      repository: "acme/platform/rules",
      provider: "gitlab",
      defaultBranch: "main",
      policy: { blockStaleRuns: true },
    });
    expect((await resolveContext(tmp)).platform).not.toBeNull();

    remotes({ origin: "git@github.com:acme/rules.git" });
    apiPostOrThrow.mockResolvedValue({
      steeringVersion: 7,
      headCommit: null,
      repository: "acme/rules",
      provider: "gitlab",
      defaultBranch: "main",
      policy: { blockStaleRuns: true },
    });
    expect((await resolveContext(tmp)).platform).toBeNull();
  });

  it("says so when a personal exclusion was refused", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    await writeFile(
      join(tmp, ".oxagen", "settings.local.json"),
      JSON.stringify({ steering: { exclude: [".oxagen/rules"] } }),
      "utf8",
    );
    const ctx = await resolveContext(tmp);
    expect(ctx.policy.exclude).not.toContain(".oxagen/rules");
    expect(ctx.warnings.join(" ")).toContain(".oxagen/rules");
  });

  it("reports a settings file it could not parse", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    await writeFile(join(tmp, ".oxagen", "settings.json"), "{ nope", "utf8");
    const ctx = await resolveContext(tmp);
    expect(ctx.warnings[0]).toContain("not valid JSON");
  });

  // The committed read is what audits the working copy, so letting the
  // working copy say which ref to read it from lets the file choose its own
  // auditor.
  it("reads the committed gates from the remote's own default branch when the platform is silent", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    await writeFile(
      join(tmp, ".oxagen", "settings.json"),
      JSON.stringify({
        steering: { blockStaleRuns: false, remote: "fork", branch: "stale" },
      }),
      "utf8",
    );
    const { specs } = gitStub({
      remotes: { origin: "git@github.com:acme/app.git" },
      blobs: {
        "refs/remotes/origin/HEAD:.oxagen/settings.json": JSON.stringify({
          steering: { blockStaleRuns: true },
        }),
        // The ref the working copy asked for holds no gate. Before the fix
        // this is the one that was read, so nothing came back and the
        // working copy's `false` stood.
        "refs/remotes/fork/stale:.oxagen/settings.json": JSON.stringify({
          steering: {},
        }),
      },
    });
    const ctx = await resolveContext(tmp);
    expect(specs).toEqual(["refs/remotes/origin/HEAD:.oxagen/settings.json"]);
    expect(ctx.policy.blockStaleRuns).toBe(true);
    expect(ctx.policy.sources.blockStaleRuns).toBe("project");
  });

  // Reading the committed gates from the authority fixed where they are read.
  // The comparison still ran against the working copy's `remote` and
  // `branch`, so a checkout kept the committed `blockStaleRuns: true` and
  // measured it against an older cached ref: `current`, and a prompt allowed
  // on a checkout behind the real production branch.
  it("compares against the authority's ref, not the ref the working copy named", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    await writeFile(
      join(tmp, ".oxagen", "settings.json"),
      JSON.stringify({
        steering: { blockStaleRuns: false, remote: "fork", branch: "stale" },
      }),
      "utf8",
    );
    gitStub({
      remotes: { origin: "git@github.com:acme/app.git" },
      blobs: {
        "refs/remotes/origin/HEAD:.oxagen/settings.json": JSON.stringify({
          steering: { blockStaleRuns: true },
        }),
      },
    });
    const ctx = await resolveContext(tmp);
    expect(ctx.policy.blockStaleRuns).toBe(true);
    // The gate is enforced against the ref its own gates came off.
    expect(ctx.policy.remote).toBe("origin");
    expect(ctx.policy.branch).toBeNull();
  });

  // The same pin, reloaded. `evaluateGate` folds again after its fetch, and
  // that fold reads the same policy the first one did.
  it("keeps the authority's ref when the policy is reloaded", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    await writeFile(
      join(tmp, ".oxagen", "settings.json"),
      JSON.stringify({
        steering: { blockStaleRuns: false, remote: "fork", branch: "stale" },
      }),
      "utf8",
    );
    gitStub({
      remotes: { origin: "git@github.com:acme/app.git" },
      blobs: {
        "refs/remotes/origin/HEAD:.oxagen/settings.json": JSON.stringify({
          steering: { blockStaleRuns: true },
        }),
      },
    });
    const ctx = await resolveContext(tmp);
    const again = await ctx.reloadPolicy();
    expect(again.blockStaleRuns).toBe(true);
    expect(again.remote).toBe("origin");
    expect(again.branch).toBeNull();
  });

  it("reads them from the bound remote and the approved branch when the platform answered", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    await writeFile(
      join(tmp, ".oxagen", "settings.local.json"),
      JSON.stringify({ steering: { remote: "fork", branch: "stale" } }),
      "utf8",
    );
    const { specs } = gitStub({
      remotes: {
        fork: "git@github.com:someone/app.git",
        upstream: "git@github.com:acme/app.git",
      },
      blobs: {},
    });
    apiPostOrThrow.mockResolvedValue({
      steeringVersion: 7,
      headCommit: null,
      repository: "acme/app",
      defaultBranch: "release",
      policy: {},
    });
    await resolveContext(tmp);
    expect(specs).toEqual([
      "refs/remotes/upstream/release:.oxagen/settings.json",
    ]);
  });

  // The gate's own fetch moves the ref these gates are read from, so the
  // answer from before the fetch is one publication out of date.
  it("picks up a gate that the ref gained since the first read", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    const spec = "refs/remotes/origin/HEAD:.oxagen/settings.json";
    const blobs: Record<string, string> = {
      [spec]: JSON.stringify({ steering: { blockStaleRuns: false } }),
    };
    gitStub({ remotes: { origin: "git@github.com:acme/app.git" }, blobs });
    const ctx = await resolveContext(tmp);
    expect(ctx.policy.blockStaleRuns).toBe(false);

    blobs[spec] = JSON.stringify({ steering: { blockStaleRuns: true } });
    const reloaded = await ctx.reloadPolicy();
    expect(reloaded.blockStaleRuns).toBe(true);
    expect(ctx.policy.blockStaleRuns).toBe(false);
  });

  it("reports a ref that stopped parsing between the two reads", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    const spec = "refs/remotes/origin/HEAD:.oxagen/settings.json";
    const blobs: Record<string, string> = {
      [spec]: JSON.stringify({ steering: { blockStaleRuns: true } }),
    };
    gitStub({ remotes: { origin: "git@github.com:acme/app.git" }, blobs });
    const ctx = await resolveContext(tmp);
    expect(ctx.warnings.join(" ")).not.toContain("not valid JSON");

    blobs[spec] = "{ nope";
    await ctx.reloadPolicy();
    expect(ctx.warnings.join(" ")).toContain("not valid JSON");
  });
});

describe("steering status", () => {
  it("prints the verdict, the files and both gates", async () => {
    const w = captureWriter();
    await steeringStatus({}, w.writer, process.cwd());
    expect(w.output()).toContain("1 record(s) behind origin/main");
    expect(w.output()).toContain(".oxagen/rules/ctx.a.toml");
    expect(w.output()).toContain("Auto-sync: off. Block stale runs: off.");
  });

  it("emits one line of JSON with --json", async () => {
    const w = captureWriter();
    await steeringStatus({ json: true }, w.writer, process.cwd());
    const lines = w.output().trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(payload.status).toBe("behind");
    expect(payload.behindByRecords).toBe(1);
  });

  it("never syncs", async () => {
    await steeringStatus({}, captureWriter().writer, process.cwd());
    expect(syncSteering).not.toHaveBeenCalled();
  });
});

describe("steering sync", () => {
  it("reports success and leaves the exit code alone", async () => {
    syncSteering.mockResolvedValue({
      applied: true,
      refusal: null,
      message: "Synced 1 file.",
      updated: ["a"],
      removed: [],
      fromCommit: "abc",
      committed: false,
    });
    const w = captureWriter();
    await steeringSync({}, w.writer, process.cwd());
    expect(w.output()).toContain("Synced 1 file.");
    expect(process.exitCode).toBeUndefined();
  });

  // A script running `oxagen steering sync && …` has to be able to tell a
  // sync that happened from one that was declined.
  it("exits 1 when the sync refused", async () => {
    syncSteering.mockResolvedValue({
      applied: false,
      refusal: "dirty",
      message: "`.oxagen/` has uncommitted changes.",
      updated: [],
      removed: [],
      fromCommit: null,
      committed: false,
    });
    await steeringSync({}, captureWriter().writer, process.cwd());
    expect(process.exitCode).toBe(1);
  });

  it("treats nothing to do as success", async () => {
    syncSteering.mockResolvedValue({
      applied: false,
      refusal: "not_behind",
      message: "Already current.",
      updated: [],
      removed: [],
      fromCommit: null,
      committed: false,
    });
    await steeringSync({}, captureWriter().writer, process.cwd());
    expect(process.exitCode).toBeUndefined();
  });

  it("passes --force, --commit and --dry-run through", async () => {
    syncSteering.mockResolvedValue({
      applied: false,
      refusal: null,
      message: "Would take 1 file.",
      updated: [],
      removed: [],
      fromCommit: "abc",
      committed: false,
    });
    await steeringSync(
      { force: true, commit: true, dryRun: true },
      captureWriter().writer,
      process.cwd(),
    );
    expect(syncSteering).toHaveBeenCalledWith(
      expect.objectContaining({ force: true, commit: true, dryRun: true }),
    );
  });
});

describe("steering gate", () => {
  const decision = (action: "allow" | "warn" | "block") => ({
    action,
    verdict,
    policy: resolveSteeringPolicy([]),
    sync: null,
    exitCode: action === "block" ? (2 as const) : (0 as const),
  });

  it("is silent and exits 0 on a current checkout", async () => {
    evaluateGate.mockResolvedValue({
      ...decision("allow"),
      verdict: { ...verdict, status: "current", missing: [] },
    });
    const w = splitWriter();
    await steeringGate({}, w.writer, process.cwd());
    expect(w.out()).toBe("");
    expect(w.err()).toBe("");
    expect(process.exitCode).toBe(0);
  });

  // A malformed `.oxagen/settings.json` loses its layer — and with it a
  // project-level `blockStaleRuns` — so the gate must say why, on stderr, and
  // still fail open. stdout stays clean for the harness's JSON.
  it("reports a settings file it could not read, and still allows", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    await writeFile(join(tmp, ".oxagen", "settings.json"), "{ nope", "utf8");
    evaluateGate.mockResolvedValue({
      ...decision("allow"),
      verdict: { ...verdict, status: "current", missing: [] },
    });
    const w = splitWriter();
    await steeringGate({ harness: "claude-code" }, w.writer, tmp);
    expect(w.err()).toContain("not valid JSON");
    expect(w.out()).not.toContain("not valid JSON");
    expect(process.exitCode).toBe(0);
  });

  // The gate's fetch is what moves the ref the production branch's gates are
  // read from, so the gate has to be able to ask for them again afterwards.
  it("hands the gate a way to read the committed gates again", async () => {
    evaluateGate.mockResolvedValue(decision("allow"));
    await steeringGate({}, splitWriter().writer, process.cwd());
    expect(evaluateGate).toHaveBeenCalledWith(
      expect.objectContaining({ reloadPolicy: expect.any(Function) }),
    );
  });

  // The check's eight seconds used to start fresh after the reads had already
  // spent theirs, which is how the path added up past the hook's twenty.
  it("gives the freshness check what the reads left, not a fresh eight seconds", async () => {
    evaluateGate.mockResolvedValue(decision("allow"));
    await steeringGate({}, splitWriter().writer, process.cwd());
    expect(evaluateGate).toHaveBeenCalledWith(
      expect.objectContaining({ networkBudgetMs: expect.any(Number) }),
    );
    const [[options]] = evaluateGate.mock.calls as [
      [{ networkBudgetMs: number }],
    ];
    expect(options.networkBudgetMs).toBeGreaterThan(0);
    expect(options.networkBudgetMs).toBeLessThanOrEqual(
      DEFAULT_NETWORK_BUDGET_MS,
    );
  });

  // The check's ancestry loop runs one local git call per commit published at
  // the newest instant, so it is bounded by the gate's whole deadline and not
  // by the network slice inside it.
  it("hands the check what is left of the gate's own budget", async () => {
    evaluateGate.mockResolvedValue(decision("allow"));
    await steeringGate({}, splitWriter().writer, process.cwd());
    const [[options]] = evaluateGate.mock.calls as [[{ hookBudgetMs: number }]];
    expect(options.hookBudgetMs).toBeGreaterThan(0);
    expect(options.hookBudgetMs).toBeLessThanOrEqual(HOOK_PATH_BUDGET_MS);
  });

  it("warns on stderr and still exits 0", async () => {
    evaluateGate.mockResolvedValue(decision("warn"));
    const w = splitWriter();
    await steeringGate({}, w.writer, process.cwd());
    expect(w.err()).toContain("behind origin/main");
    expect(w.out()).toBe("");
    expect(process.exitCode).toBe(0);
  });

  it("refuses with exit 2", async () => {
    evaluateGate.mockResolvedValue(decision("block"));
    const w = splitWriter();
    await steeringGate({}, w.writer, process.cwd());
    expect(w.err()).toContain("Run stopped.");
    expect(process.exitCode).toBe(2);
  });

  it("puts the harness JSON on stdout", async () => {
    evaluateGate.mockResolvedValue(decision("block"));
    const w = splitWriter();
    await steeringGate({ harness: "claude-code" }, w.writer, process.cwd());
    const payload = JSON.parse(w.out().trim()) as Record<string, unknown>;
    expect(payload.decision).toBe("block");
    expect(payload.hookSpecificOutput).toMatchObject({
      permissionDecision: "deny",
    });
  });

  // A hook that throws is a broken prompt. This is the property the whole
  // feature depends on to be safe to leave installed.
  it("exits 0 rather than letting anything escape", async () => {
    evaluateGate.mockRejectedValue(new Error("git exploded"));
    const w = splitWriter();
    await expect(
      steeringGate({}, w.writer, process.cwd()),
    ).resolves.toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  it("makes no network call with --no-network", async () => {
    evaluateGate.mockResolvedValue(decision("allow"));
    await steeringGate({ network: false }, splitWriter().writer, process.cwd());
    expect(apiPostOrThrow).not.toHaveBeenCalled();
    expect(evaluateGate).toHaveBeenCalledWith(
      expect.objectContaining({ allowNetwork: false }),
    );
  });
});

describe("steering hooks", () => {
  it("installs into every harness by default", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    const w = captureWriter();
    await steeringHooks("install", {}, w.writer, tmp);
    expect(w.output()).toContain(".claude/settings.json");
    expect(w.output()).toContain(".codex/hooks.json");
  });

  it("rejects an unknown harness with a usage exit", async () => {
    const w = splitWriter();
    await steeringHooks(
      "install",
      { harness: "nope" },
      w.writer,
      process.cwd(),
    );
    expect(w.err()).toContain("--harness is one of");
    expect(process.exitCode).toBe(2);
  });

  it("rejects an unknown action with a usage exit", async () => {
    const w = splitWriter();
    await steeringHooks("frobnicate", {}, w.writer, process.cwd());
    expect(process.exitCode).toBe(2);
  });

  // The escape hatch for every harness Oxagen has not met yet.
  it("prints the generic contract in the status listing", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    const w = captureWriter();
    await steeringHooks("status", {}, w.writer, tmp);
    expect(w.output()).toContain("oxagen steering gate --harness <name>");
    expect(w.output()).toContain("Exit 2 means refuse it");
  });
});

describe("parseRemoteUrl", () => {
  it.each([
    ["git@github.com:Acme/App.git", "github.com/acme/app"],
    ["https://github.com/acme/app.git", "github.com/acme/app"],
    ["https://github.com/acme/app", "github.com/acme/app"],
    ["ssh://git@github.com/acme/app.git", "github.com/acme/app"],
    ["ssh://git@github.com:22/acme/app.git", "github.com/acme/app"],
    ["git@gitlab.com:acme/app.git", "gitlab.com/acme/app"],
    [
      "https://gitlab.com/Acme/Platform/Rules.git",
      "gitlab.com/acme/platform/rules",
    ],
  ])("reads %s as %s", (url, expected) => {
    expect(parseRemoteUrl(url)).toBe(expected);
  });

  it.each([
    "/tmp/acme/app",
    "file:///tmp/acme/app",
    "../acme/app",
    "https://github.com/acme",
    "https://github.com/acme/app/extra",
    "",
    // Plaintext transports do not say who the server is, so they never
    // identify the bound repository the gate may auto-sync from.
    "http://github.com/acme/app.git",
    "git://github.com/acme/app.git",
  ])("is not a hosted repository: %j", (url) => {
    expect(parseRemoteUrl(url)).toBeNull();
  });
});
