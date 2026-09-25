/**
 * What a session changed, read from real repositories.
 *
 * Every other reader test in this package answers git with canned stdout,
 * which proves the parsing and nothing about what git prints. The rule in
 * `readSessionChanges` (ADR-186) depends on what `git log`, `git diff`, and
 * `git status` actually say after a pull, a rebase, and a squash merge, so
 * these tests run git against repositories made in a temporary directory,
 * never against a checkout.
 */
import { execFile, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TachoEvent } from "../envelope";
import { writeSensitiveFileAtomic } from "../host/fs";
import { writeHostFile } from "../host/host-file";
import type { ExecAsync } from "../host/service";
import { mergeTachoSettings } from "../host/settings-writer";
import {
  bundleSigner,
  scratchPaths,
  TEST_ENROLLMENT,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { type DaemonHandle, startDaemon } from "./daemon";
import {
  readPreexistingPaths,
  readSessionChanges,
  readWorkingTreeChanges,
  type WorktreeAttribution,
} from "./git-facts";

const ME = "agent@example.com";
const OTHER = "someone-else@example.com";

const scratch: string[] = [];
const daemons: DaemonHandle[] = [];
afterEach(async () => {
  for (const handle of daemons.splice(0)) await handle.stop();
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** Git with no global or system configuration, so the host's cannot leak in. */
function gitEnv(dir: string): NodeJS.ProcessEnv {
  const empty = join(dir, ".gitconfig-empty");
  writeFileSync(empty, "");
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: empty,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

interface Rig {
  /** The bare repository every clone pushes to. */
  origin: string;
  /** The checkout the session works in. */
  work: string;
  /** Another clone, where someone else commits and pushes. */
  upstream: string;
  git: (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => string;
  exec: ExecAsync;
}

function rig(): Rig {
  // Real path, because git answers `--show-toplevel` with one and macOS
  // puts the temporary directory behind a symlink.
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "tacho-session-changes-")),
  );
  scratch.push(root);
  const env = gitEnv(root);
  const git = (cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}) =>
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
      { cwd, env: { ...env, ...extra }, encoding: "utf8" },
    );
  const exec: ExecAsync = (command, args) =>
    new Promise((resolve) => {
      execFile(
        command,
        args,
        { env, encoding: "utf8" },
        (error, stdout, stderr) => {
          const code = (error as (Error & { code?: unknown }) | null)?.code;
          resolve({
            status: error === null ? 0 : typeof code === "number" ? code : null,
            stdout,
            stderr,
          });
        },
      );
    });
  const origin = join(root, "origin.git");
  git(root, ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = join(root, "seed");
  git(root, ["clone", "-q", origin, seed]);
  identify(git, seed, ME);
  writeFileSync(join(seed, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(seed, "shared.txt"), "shared\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-q", "-m", "seed"], datedNow());
  git(seed, ["push", "-q", "origin", "main"]);
  const work = join(root, "work");
  git(root, ["clone", "-q", origin, work]);
  identify(git, work, ME);
  const upstream = join(root, "upstream");
  git(root, ["clone", "-q", origin, upstream]);
  identify(git, upstream, OTHER);
  return { origin, work, upstream, git, exec };
}

function identify(git: Rig["git"], cwd: string, email: string): void {
  git(cwd, ["config", "user.email", email]);
  git(cwd, ["config", "user.name", email.split("@")[0] ?? "someone"]);
}

/** A commit dated now, which a clock read before it counts from. */
function datedNow(): NodeJS.ProcessEnv {
  const at = `@${Math.floor(Date.now() / 1000)} +0000`;
  return { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
}

/** Someone else commits two files upstream and pushes. */
function pushUpstream(r: Rig): void {
  r.git(r.upstream, ["pull", "-q", "--ff-only", "origin", "main"]);
  writeFileSync(join(r.upstream, "upstream-1.txt"), "theirs\n");
  writeFileSync(join(r.upstream, "upstream-2.txt"), "theirs too\n");
  writeFileSync(join(r.upstream, "shared.txt"), "shared\nupstream line\n");
  r.git(r.upstream, ["add", "."]);
  r.git(r.upstream, ["commit", "-q", "-m", "upstream work"], datedNow());
  r.git(r.upstream, ["push", "-q", "origin", "main"]);
}

/** What the lane records at a session's first read of `work`. */
async function firstRead(r: Rig): Promise<WorktreeAttribution> {
  const startedAt = Date.now();
  // Past the start, so a file the session writes has a later time than it.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return {
    baseline: r.git(r.work, ["rev-parse", "HEAD"]).trim(),
    firstReadAt: startedAt,
    preexisting: await readPreexistingPaths(r.exec, r.work, startedAt),
  };
}

function paths(changes: { repo_relative_path: string }[] | undefined) {
  return (changes ?? []).map((change) => change.repo_relative_path).sort();
}

describe("readSessionChanges against a real repository", () => {
  it("leaves out the files a fetch and reset to upstream brought in", async () => {
    const r = rig();
    const start = await firstRead(r);
    pushUpstream(r);
    r.git(r.work, ["fetch", "-q", "origin"]);
    r.git(r.work, ["reset", "-q", "--hard", "origin/main"]);

    const read = await readSessionChanges(r.exec, r.work, start);
    expect(read?.changes).toEqual([]);
    expect(read?.basis).toBe("session");
    // The measure this replaced reports every file the pull touched.
    expect(
      paths(await readWorkingTreeChanges(r.exec, r.work, start.baseline)),
    ).toEqual(["shared.txt", "upstream-1.txt", "upstream-2.txt"]);
  });

  it("leaves out the files a pull brought in", async () => {
    const r = rig();
    const start = await firstRead(r);
    pushUpstream(r);
    r.git(r.work, ["pull", "-q", "--ff-only", "origin", "main"]);
    expect((await readSessionChanges(r.exec, r.work, start))?.changes).toEqual(
      [],
    );
  });

  it("reports the files the session committed, and keeps them after a rebase onto upstream", async () => {
    const r = rig();
    const start = await firstRead(r);
    writeFileSync(join(r.work, "mine.txt"), "a\nb\n");
    writeFileSync(join(r.work, "a.txt"), "one\ntwo\nthree\nfour\n");
    r.git(r.work, ["add", "."]);
    r.git(r.work, ["commit", "-q", "-m", "session work"], datedNow());

    const committed = await readSessionChanges(r.exec, r.work, start);
    expect(committed?.changes).toEqual([
      {
        path: join(r.work, "a.txt"),
        repo_relative_path: "a.txt",
        status: "modified",
        lines_added: 1,
        lines_removed: 0,
      },
      {
        path: join(r.work, "mine.txt"),
        repo_relative_path: "mine.txt",
        status: "added",
        lines_added: 2,
        lines_removed: 0,
      },
    ]);
    expect(committed?.ownCommits).toHaveLength(1);

    // Upstream moves, and the session rebases its commit onto it. The rebase
    // gives the commit a new sha stamped with the session's email and the
    // time it ran, so it still counts, and the upstream commit does not.
    pushUpstream(r);
    r.git(r.work, ["fetch", "-q", "origin"]);
    r.git(r.work, ["rebase", "-q", "origin/main"], datedNow());
    const rebased = await readSessionChanges(r.exec, r.work, {
      ...start,
      ownCommits: committed?.ownCommits,
    });
    expect(paths(rebased?.changes)).toEqual(["a.txt", "mine.txt"]);
  });

  it("does not count a commit with the session's email made before its first read", async () => {
    const r = rig();
    // A commit made yesterday on another branch, by the same person.
    r.git(r.work, ["checkout", "-q", "-b", "older"]);
    writeFileSync(join(r.work, "yesterday.txt"), "old work\n");
    r.git(r.work, ["add", "."]);
    const yesterday = `@${Math.floor(Date.now() / 1000) - 86_400} +0000`;
    r.git(r.work, ["commit", "-q", "-m", "older work"], {
      GIT_AUTHOR_DATE: yesterday,
      GIT_COMMITTER_DATE: yesterday,
    });
    r.git(r.work, ["checkout", "-q", "main"]);
    const start = await firstRead(r);
    // The session switches to that branch and changes nothing.
    r.git(r.work, ["checkout", "-q", "older"]);
    expect((await readSessionChanges(r.exec, r.work, start))?.changes).toEqual(
      [],
    );
  });

  it("keeps a counted commit after a squash merge comes back through a pull", async () => {
    const r = rig();
    const start = await firstRead(r);
    r.git(r.work, ["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(r.work, "feature.txt"), "x\ny\nz\n");
    r.git(r.work, ["add", "."]);
    r.git(r.work, ["commit", "-q", "-m", "feature"], datedNow());
    const before = await readSessionChanges(r.exec, r.work, start);
    expect(paths(before?.changes)).toEqual(["feature.txt"]);

    // The forge squash-merges the branch as its own commit, under its own
    // email, and the session goes back to main and pulls it.
    r.git(r.upstream, ["pull", "-q", "--ff-only", "origin", "main"]);
    writeFileSync(join(r.upstream, "feature.txt"), "x\ny\nz\n");
    r.git(r.upstream, ["add", "."]);
    r.git(r.upstream, ["commit", "-q", "-m", "feature (#1)"], datedNow());
    r.git(r.upstream, ["push", "-q", "origin", "main"]);
    r.git(r.work, ["checkout", "-q", "main"]);
    r.git(r.work, ["pull", "-q", "--ff-only", "origin", "main"]);

    const after = await readSessionChanges(r.exec, r.work, {
      ...start,
      ownCommits: before?.ownCommits,
    });
    expect(paths(after?.changes)).toEqual(["feature.txt"]);
    // Without the commit carried from the earlier read, the squash commit is
    // someone else's and the session's work leaves the record.
    expect((await readSessionChanges(r.exec, r.work, start))?.changes).toEqual(
      [],
    );
  });

  it("leaves out edits that were already in the worktree until their content changes", async () => {
    const r = rig();
    // A person's uncommitted work, from before the session started. Its
    // change time cannot be set back, so the session starts after it.
    writeFileSync(join(r.work, "a.txt"), "one\ntwo\nthree\nmine\n");
    writeFileSync(join(r.work, "notes.txt"), "a draft\n");
    unlinkSync(join(r.work, "shared.txt"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const start = await firstRead(r);
    expect(Object.keys(start.preexisting?.paths ?? {}).sort()).toEqual([
      "a.txt",
      "notes.txt",
      "shared.txt",
    ]);
    // The session creates one file and touches nothing else.
    writeFileSync(join(r.work, "new.txt"), "session\n");
    const first = await readSessionChanges(r.exec, r.work, start);
    expect(paths(first?.changes)).toEqual(["new.txt"]);
    expect(first?.preexisting).toBe("complete");

    // Rewriting a file with the same bytes is not a change to it.
    writeFileSync(join(r.work, "notes.txt"), "a draft\n");
    expect(
      paths((await readSessionChanges(r.exec, r.work, start))?.changes),
    ).toEqual(["new.txt"]);

    // Once the session edits one of them, it is the session's too.
    writeFileSync(join(r.work, "notes.txt"), "a draft\nfinished\n");
    expect(
      paths((await readSessionChanges(r.exec, r.work, start))?.changes),
    ).toEqual(["new.txt", "notes.txt"]);
  });

  it("does not record an edit made after the session started as already there", async () => {
    const r = rig();
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The session writes before the lane's first read of this worktree, as
    // it does when a tool call moves it to another worktree.
    writeFileSync(join(r.work, "early.txt"), "written first\n");
    const preexisting = await readPreexistingPaths(r.exec, r.work, startedAt);
    expect(preexisting?.paths).toEqual({});
    const read = await readSessionChanges(r.exec, r.work, {
      baseline: r.git(r.work, ["rev-parse", "HEAD"]).trim(),
      firstReadAt: startedAt,
      ...(preexisting !== undefined ? { preexisting } : {}),
    });
    expect(paths(read?.changes)).toEqual(["early.txt"]);
  });

  it("measures a session restored without a first-read time the old way, and says so", async () => {
    const r = rig();
    const baseline = r.git(r.work, ["rev-parse", "HEAD"]).trim();
    pushUpstream(r);
    r.git(r.work, ["pull", "-q", "--ff-only", "origin", "main"]);
    const read = await readSessionChanges(r.exec, r.work, { baseline });
    expect(read?.basis).toBe("baseline");
    expect(paths(read?.changes)).toEqual([
      "shared.txt",
      "upstream-1.txt",
      "upstream-2.txt",
    ]);
  });
});

describe("the daemon's reconciliation against a real repository", () => {
  const SESSION = "11111111-2222-3333-4444-555555555555";

  async function boot(exec: ExecAsync): Promise<DaemonHandle> {
    const paths = scratchPaths();
    const signer = bundleSigner();
    const host = testHostFile(signer, signer.sign(unsignedBundle()));
    writeHostFile(paths.hostFile, host);
    writeSensitiveFileAtomic(
      paths.claudeSettings,
      JSON.stringify(
        mergeTachoSettings(
          {},
          {
            enrollmentId: TEST_ENROLLMENT,
            hookCommand: "x",
            port: 1,
            localToken: host.local_token,
          },
        ).settings,
      ),
    );
    const handle = await startDaemon({
      paths,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      exec: () => ({ status: 127, stdout: "", stderr: "" }),
      execAsync: exec,
      now: () => Date.now(),
      log: () => undefined,
      listen: false,
      transcriptRoots: [`${paths.root}/no-transcripts`],
      timers: { detectorMs: 0, sweepMs: 0, checkpointMs: 0, commandsPollMs: 0 },
    });
    daemons.push(handle);
    return handle;
  }

  function hook(name: string, cwd: string) {
    return {
      payload: { session_id: SESSION, hook_event_name: name, cwd },
      env: {},
    };
  }

  function reconciliations(handle: DaemonHandle): TachoEvent[] {
    return [
      ...(handle.registry.get(SESSION)?.recorder.sealedEvents ?? []),
    ].filter((event) => event.kind === "oxagen:worktree_reconciled");
  }

  it("records none of the files a pull brought in, and the session's own", async () => {
    const r = rig();
    // A person's uncommitted edit, there before the session started.
    writeFileSync(join(r.work, "a.txt"), "one\ntwo\nthree\nmine\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const handle = await boot(r.exec);
    await handle.api.handleHook(hook("SessionStart", r.work));
    await handle.tick();

    pushUpstream(r);
    r.git(r.work, ["pull", "-q", "--ff-only", "origin", "main"]);
    writeFileSync(join(r.work, "session.txt"), "the session wrote this\n");
    await handle.api.handleHook(hook("Stop", r.work));
    await handle.tick();

    const [frame] = reconciliations(handle);
    const body = frame?.body as {
      observed_changes: { repo_relative_path: string }[];
    };
    expect(
      body.observed_changes.map((change) => change.repo_relative_path),
    ).toEqual(["session.txt"]);
    expect(frame?.attrs).toMatchObject({
      changes_basis: "session",
      pre_session_changes: "excluded",
    });
  });
});
