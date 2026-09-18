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
  findProjectRoot,
  toSignal,
  parseRemoteUrl,
  resolveContext,
  steeringGate,
  steeringHooks,
  steeringStatus,
  steeringSync,
} from "./steering";
import { resolveSteeringPolicy } from "@oxagen/steering-freshness";
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
