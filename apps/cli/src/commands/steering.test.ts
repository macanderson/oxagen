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
  apiPostOrThrow: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
  evaluateGate: vi.fn(),
  checkSteeringFreshness: vi.fn(),
  syncSteering: vi.fn(),
  // The CLI must never reach a real git in a unit test. Hoisted so a test can
  // say what `git remote get-url` answered, which is how the checkout's own
  // repository is identified.
  execGit: vi.fn<(args: readonly string[]) => Promise<string>>(),
}));

vi.mock("../lib/api.js", () => ({ apiPostOrThrow }));

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

import { captureWriter, type CommandWriter } from "../lib/capture-writer";
import {
  findProjectRoot,
  resolveContext,
  steeringGate,
  steeringHooks,
  steeringStatus,
  steeringSync,
} from "./steering";
import { resolveSteeringPolicy } from "@oxagen/steering-freshness";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
});

describe("findProjectRoot", () => {
  it("walks up to the directory holding .oxagen", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    await mkdir(join(tmp, ".oxagen"), { recursive: true });
    await mkdir(join(tmp, "packages", "deep"), { recursive: true });
    expect(findProjectRoot(join(tmp, "packages", "deep"))).toBe(tmp);
  });

  // Guessing some ancestor would point the check at the wrong repository.
  it("falls back to the starting directory when there is no .oxagen above it", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "oxagen-cli-"));
    expect(findProjectRoot(tmp)).toBe(tmp);
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
    apiPostOrThrow.mockResolvedValue({
      steeringVersion: 7,
      headCommit: null,
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
    execGit.mockResolvedValue("git@github.com:acme/this-one.git");
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
    execGit.mockResolvedValue("https://github.com/Acme/This-One.git");
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
    apiPostOrThrow.mockResolvedValue({
      steeringVersion: 7,
      headCommit: null,
      repository: null,
      defaultBranch: "release",
      policy: { blockStaleRuns: true },
    });
    const ctx = await resolveContext(tmp);
    // `workspace` is the last scope, so it outranks the personal file too.
    expect(ctx.policy.branch).toBe("release");
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
