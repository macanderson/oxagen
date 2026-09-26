/**
 * What a session changed, read from real repositories.
 *
 * Every other reader test in this package answers git with canned stdout,
 * which proves the parsing and nothing about what git prints. The rule in
 * `readSessionChanges` (ADR-188) depends on what `git log`, `git diff`, and
 * `git status` actually say after a pull, a rebase, and a squash merge, so
 * these tests run git against repositories made in a temporary directory,
 * never against a checkout.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
import { toProtocolTimestamp } from "../timestamp";
import { type DaemonHandle, startDaemon } from "./daemon";
import { readWorkingTreeChanges } from "./git-facts";
import {
  datedNow,
  ME,
  pushUpstream,
  type Rig,
  removeRigs,
  rig,
} from "./git-rig.test-support";
import {
  MAX_SESSION_COMMITS,
  readPreexistingPaths,
  readSessionChanges,
  type WorktreeAttribution,
} from "./session-changes";

/** An identity the agent's shell sets, which the repository's config does not name. */
const AGENT_EMAIL = "agent-bot@example.com";

const daemons: DaemonHandle[] = [];
afterEach(async () => {
  for (const handle of daemons.splice(0)) await handle.stop();
  removeRigs();
});

/**
 * The forge squash-merges the session's branch as one commit under its own
 * email, and the session goes back to main and pulls it.
 */
function squashMergeAndPull(r: Rig, file: string, content: string): void {
  r.git(r.upstream, ["pull", "-q", "--ff-only", "origin", "main"]);
  writeFileSync(join(r.upstream, file), content);
  r.git(r.upstream, ["add", "."]);
  r.git(r.upstream, ["commit", "-q", "-m", `${file} (#1)`], datedNow());
  r.git(r.upstream, ["push", "-q", "origin", "main"]);
  r.git(r.work, ["checkout", "-q", "main"]);
  r.git(r.work, ["pull", "-q", "--ff-only", "origin", "main"]);
}

/** What the lane records at a session's first read of `work`. */
async function firstRead(
  r: Rig,
  copies?: { dir: string; capBytes: number },
): Promise<WorktreeAttribution> {
  const startedAt = Date.now();
  // Past the start, so a file the session writes has a later time than it.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return {
    baseline: r.git(r.work, ["rev-parse", "HEAD"]).trim(),
    firstReadAt: startedAt,
    preexisting: await readPreexistingPaths(r.exec, r.work, startedAt, copies),
  };
}

/** Everything git sees in `work`, ignored files included. */
function everything(r: Rig): string {
  return r.git(r.work, [
    "status",
    "--porcelain",
    "--ignored",
    "--untracked-files=all",
  ]);
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

  it("reports a commit the session made under another email, and still leaves out a pull", async () => {
    const r = rig();
    const start = await firstRead(r);
    // The agent's shell exports its own identity. tachod's does not, so the
    // email the repository stamps is still ME.
    const agent = {
      GIT_AUTHOR_EMAIL: AGENT_EMAIL,
      GIT_COMMITTER_EMAIL: AGENT_EMAIL,
    };
    writeFileSync(join(r.work, "agent.txt"), "the agent wrote this\n");
    r.git(r.work, ["add", "."]);
    r.git(r.work, ["commit", "-q", "-m", "agent work"], {
      ...datedNow(),
      ...agent,
    });
    const committed = await readSessionChanges(r.exec, r.work, start);
    expect(paths(committed?.changes)).toEqual(["agent.txt"]);

    // Upstream moves, and the agent pulls it in with a rebase under the same
    // identity. The upstream commit is on `origin/main`, so it stays out.
    pushUpstream(r);
    r.git(r.work, ["pull", "-q", "--rebase", "origin", "main"], {
      ...datedNow(),
      ...agent,
    });
    const pulled = await readSessionChanges(r.exec, r.work, {
      ...start,
      ownCommits: committed?.ownCommits,
    });
    expect(paths(pulled?.changes)).toEqual(["agent.txt"]);
  });

  it("reports a commit the session made under another email and pushed before the read", async () => {
    const r = rig();
    const start = await firstRead(r);
    const agent = {
      GIT_AUTHOR_EMAIL: AGENT_EMAIL,
      GIT_COMMITTER_EMAIL: AGENT_EMAIL,
    };
    // A commit the agent then resets away. The reflog still names it, and
    // it is no longer in the history.
    writeFileSync(join(r.work, "dropped.txt"), "reset away\n");
    r.git(r.work, ["add", "."]);
    r.git(r.work, ["commit", "-q", "-m", "dropped"], {
      ...datedNow(),
      ...agent,
    });
    r.git(r.work, ["reset", "-q", "--hard", "HEAD~1"]);
    // The commit it keeps, pushed in the same turn, so a remote-tracking ref
    // reaches it by the time the turn's reconciliation reads the worktree.
    writeFileSync(join(r.work, "agent.txt"), "the agent wrote this\n");
    r.git(r.work, ["add", "."]);
    r.git(r.work, ["commit", "-q", "-m", "agent work"], {
      ...datedNow(),
      ...agent,
    });
    r.git(r.work, ["push", "-q", "origin", "main"]);
    const pushed = await readSessionChanges(r.exec, r.work, start);
    expect(paths(pushed?.changes)).toEqual(["agent.txt"]);

    // A later pull writes `pull:` to the reflog, not `commit:`, so the
    // upstream commit stays out.
    pushUpstream(r);
    r.git(r.work, ["pull", "-q", "--ff-only", "origin", "main"]);
    const pulled = await readSessionChanges(r.exec, r.work, {
      ...start,
      ownCommits: pushed?.ownCommits,
    });
    expect(paths(pulled?.changes)).toEqual(["agent.txt"]);
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

  it("does not count a same-email commit from before the session that the session rebased", async () => {
    const r = rig();
    // A commit written yesterday on another branch, by the same person.
    r.git(r.work, ["checkout", "-q", "-b", "older"]);
    writeFileSync(join(r.work, "yesterday.txt"), "old work\n");
    r.git(r.work, ["add", "."]);
    const yesterday = `@${Math.floor(Date.now() / 1000) - 86_400} +0000`;
    r.git(r.work, ["commit", "-q", "-m", "older work"], {
      GIT_AUTHOR_DATE: yesterday,
      GIT_COMMITTER_DATE: yesterday,
    });
    // Main moves on, so a rebase onto it replays the older commit.
    r.git(r.work, ["checkout", "-q", "main"]);
    pushUpstream(r);
    r.git(r.work, ["pull", "-q", "--ff-only", "origin", "main"]);
    const start = await firstRead(r);
    r.git(r.work, ["checkout", "-q", "older"]);
    r.git(r.work, ["rebase", "-q", "main"]);

    // The replay carries the session's email and a committer date after the
    // first read. Only its author date says it was written before.
    const since = Math.floor((start.firstReadAt ?? 0) / 1000);
    const [committed, authored, email] = r
      .git(r.work, ["log", "-1", "--format=%ct %at %ce"])
      .trim()
      .split(" ");
    expect(Number(committed)).toBeGreaterThanOrEqual(since);
    expect(Number(authored)).toBeLessThan(since);
    expect(email).toBe(ME);
    expect((await readSessionChanges(r.exec, r.work, start))?.changes).toEqual(
      [],
    );
  });

  it("keeps every session commit still in the range, however many there are", async () => {
    const r = rig();
    const start = await firstRead(r);
    // More commits than a read carries over, made in one fast-import.
    const count = MAX_SESSION_COMMITS + 2;
    const ident = `agent <${ME}> ${Math.floor(Date.now() / 1000)} +0000`;
    let stream = "";
    for (let i = 0; i < count; i += 1) {
      const message = `commit ${i}\n`;
      const content = `${i}\n`;
      stream += `commit refs/heads/main\nauthor ${ident}\ncommitter ${ident}\n`;
      stream += `data ${message.length}\n${message}`;
      if (i === 0) stream += `from ${start.baseline}\n`;
      stream += `M 100644 inline f${String(i).padStart(3, "0")}.txt\n`;
      stream += `data ${content.length}\n${content}\n`;
    }
    execFileSync("git", ["fast-import", "--quiet"], {
      cwd: r.work,
      env: r.env,
      input: stream,
    });
    r.git(r.work, ["reset", "-q", "--hard", "main"]);

    const first = await readSessionChanges(r.exec, r.work, start);
    expect(first?.changes).toHaveLength(count);
    expect(first?.ownCommits).toHaveLength(MAX_SESSION_COMMITS);
    // The next read starts from the carried commits and finds the same files.
    const second = await readSessionChanges(r.exec, r.work, {
      ...start,
      ownCommits: first?.ownCommits,
    });
    expect(paths(second?.changes)).toEqual(paths(first?.changes));
  });

  it("measures from the baseline, and says so, when the session's commits cannot be read", async () => {
    const r = rig();
    const start = await firstRead(r);
    pushUpstream(r);
    r.git(r.work, ["pull", "-q", "--ff-only", "origin", "main"]);
    // A range too long for the exec's buffer or its timeout fails this way.
    const failingLog: ExecAsync = (command, args) =>
      args.includes("log")
        ? Promise.resolve({ status: 128, stdout: "", stderr: "fatal" })
        : r.exec(command, args);
    const read = await readSessionChanges(failingLog, r.work, start);
    expect(read?.basis).toBe("baseline");
    expect(paths(read?.changes)).toEqual([
      "shared.txt",
      "upstream-1.txt",
      "upstream-2.txt",
    ]);
  });

  it("measures from the baseline, and says so, when the counted commits' files cannot be read", async () => {
    const r = rig();
    const start = await firstRead(r);
    writeFileSync(join(r.work, "mine.txt"), "mine\n");
    r.git(r.work, ["add", "."]);
    r.git(r.work, ["commit", "-q", "-m", "session work"], datedNow());
    const failingShow: ExecAsync = (command, args) =>
      args.includes("--no-walk=unsorted")
        ? Promise.resolve({ status: 128, stdout: "", stderr: "fatal" })
        : r.exec(command, args);
    const read = await readSessionChanges(failingShow, r.work, start);
    expect(read?.basis).toBe("baseline");
    expect(paths(read?.changes)).toEqual(["mine.txt"]);
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

    squashMergeAndPull(r, "feature.txt", "x\ny\nz\n");

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

  it("counts only the session's lines in a file that already held edits", async () => {
    const r = rig();
    // A person's uncommitted work: one line added to a tracked file, and an
    // untracked draft.
    writeFileSync(join(r.work, "a.txt"), "one\ntwo\nthree\nperson\n");
    writeFileSync(join(r.work, "notes.txt"), "a draft\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = everything(r);
    const copies = join(r.root, "tacho", "pre-session", "session");
    const start = await firstRead(r, { dir: copies, capBytes: 1024 });

    // The session adds one line to each.
    writeFileSync(join(r.work, "a.txt"), "one\ntwo\nthree\nperson\nsession\n");
    writeFileSync(join(r.work, "notes.txt"), "a draft\nfinished\n");
    const read = await readSessionChanges(r.exec, r.work, start, copies);
    expect(read?.changes).toEqual([
      {
        path: join(r.work, "a.txt"),
        repo_relative_path: "a.txt",
        status: "modified",
        lines_added: 1,
        lines_removed: 0,
      },
      {
        path: join(r.work, "notes.txt"),
        repo_relative_path: "notes.txt",
        status: "modified",
        lines_added: 1,
        lines_removed: 0,
      },
    ]);
    expect(read?.preSessionCounts).toBe("session_only");
    // The copies live in Tacho's directory, readable by its owner alone. The
    // repository gained nothing.
    expect(statSync(copies).mode & 0o777).toBe(0o700);
    const kept = readdirSync(copies);
    expect(kept).toHaveLength(2);
    for (const name of kept)
      expect(statSync(join(copies, name)).mode & 0o777).toBe(0o600);
    writeFileSync(join(r.work, "a.txt"), "one\ntwo\nthree\nperson\n");
    writeFileSync(join(r.work, "notes.txt"), "a draft\n");
    expect(everything(r)).toBe(before);
  });

  it("measures a revert, a deletion, and a re-creation of a file that already held edits", async () => {
    const r = rig();
    writeFileSync(join(r.work, "a.txt"), "one\ntwo\nthree\nperson\n");
    writeFileSync(join(r.work, "notes.txt"), "a draft\nsecond line\n");
    unlinkSync(join(r.work, "shared.txt"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const copies = join(r.root, "tacho", "pre-session", "session");
    const start = await firstRead(r, { dir: copies, capBytes: 1024 });

    // The session puts a.txt back as HEAD has it, deletes the draft, and
    // writes shared.txt again with new content.
    r.git(r.work, ["checkout", "-q", "--", "a.txt"]);
    unlinkSync(join(r.work, "notes.txt"));
    writeFileSync(join(r.work, "shared.txt"), "rewritten\n");
    const read = await readSessionChanges(r.exec, r.work, start, copies);
    expect(
      [...(read?.changes ?? [])].sort((x, y) =>
        x.repo_relative_path < y.repo_relative_path ? -1 : 1,
      ),
    ).toMatchObject([
      {
        repo_relative_path: "a.txt",
        status: "modified",
        lines_added: 0,
        lines_removed: 1,
      },
      {
        repo_relative_path: "notes.txt",
        status: "deleted",
        lines_added: 0,
        lines_removed: 2,
      },
      {
        repo_relative_path: "shared.txt",
        status: "added",
        lines_added: 1,
        lines_removed: 0,
      },
    ]);
  });

  it("counts the whole file, and says so, when the copy would pass the session's cap", async () => {
    const r = rig();
    writeFileSync(join(r.work, "a.txt"), "one\ntwo\nthree\nperson\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const copies = join(r.root, "tacho", "pre-session", "session");
    // Fewer bytes than the file holds, so no copy is kept.
    const start = await firstRead(r, { dir: copies, capBytes: 8 });
    expect(Object.keys(start.preexisting?.paths ?? {})).toEqual(["a.txt"]);

    writeFileSync(join(r.work, "a.txt"), "one\ntwo\nthree\nperson\nsession\n");
    const read = await readSessionChanges(r.exec, r.work, start, copies);
    // Against HEAD: the person's line and the session's.
    expect(read?.changes).toMatchObject([
      { repo_relative_path: "a.txt", lines_added: 2, lines_removed: 0 },
    ]);
    expect(read?.preSessionCounts).toBe("whole_file");
  });

  it("reports a path whose entry in the state file has the wrong shape", async () => {
    const r = rig();
    const start = await firstRead(r);
    writeFileSync(join(r.work, "a.txt"), "one\ntwo\nthree\nfour\n");
    // daemon.json is checked only as far as the record being an object.
    const read = await readSessionChanges(r.exec, r.work, {
      ...start,
      preexisting: {
        paths: { "a.txt": 5 } as unknown as Record<string, null>,
        complete: true,
      },
    });
    expect(paths(read?.changes)).toEqual(["a.txt"]);
    // The record lost that path, and the row counts the whole file.
    expect(read?.preexisting).toBe("partial");
    expect(read?.preSessionCounts).toBe("whole_file");
  });

  it("drops a path from the state file that leaves the repository", async () => {
    const r = rig();
    const start = await firstRead(r);
    writeFileSync(join(r.root, "outside.txt"), "not in the repository\n");
    const read = await readSessionChanges(r.exec, r.work, {
      ...start,
      preexisting: { paths: { "../outside.txt": null }, complete: true },
    });
    expect(paths(read?.changes)).toEqual([]);
    expect(read?.measured?.fromPreSession).toEqual([]);
    expect(read?.preexisting).toBe("partial");
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

  /** A daemon on `paths`, enrolled on first use and restarted after. */
  async function boot(
    exec: ExecAsync,
    paths = scratchPaths(),
  ): Promise<DaemonHandle> {
    if (!existsSync(paths.hostFile)) {
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
    }
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

  /** The paths each reconciliation frame listed, in order. */
  function listed(handle: DaemonHandle): string[][] {
    return reconciliations(handle).map((frame) =>
      (
        frame.body as { observed_changes: { repo_relative_path: string }[] }
      ).observed_changes.map((change) => change.repo_relative_path),
    );
  }

  async function stop(handle: DaemonHandle): Promise<void> {
    daemons.splice(daemons.indexOf(handle), 1);
    await handle.stop();
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
  it("records a file the agent committed under its own GIT_COMMITTER_EMAIL", async () => {
    const r = rig();
    const handle = await boot(r.exec);
    await handle.api.handleHook(hook("SessionStart", r.work));
    await handle.tick();
    writeFileSync(join(r.work, "agent.txt"), "the agent wrote this\n");
    r.git(r.work, ["add", "."]);
    r.git(r.work, ["commit", "-q", "-m", "agent work"], {
      ...datedNow(),
      GIT_COMMITTER_EMAIL: AGENT_EMAIL,
    });
    await handle.api.handleHook(hook("Stop", r.work));
    await handle.tick();
    expect(listed(handle)).toEqual([["agent.txt"]]);
  });

  it("records a file the agent committed under its own GIT_COMMITTER_EMAIL and pushed in the same turn", async () => {
    const r = rig();
    const handle = await boot(r.exec);
    await handle.api.handleHook(hook("SessionStart", r.work));
    await handle.tick();
    writeFileSync(join(r.work, "agent.txt"), "the agent wrote this\n");
    r.git(r.work, ["add", "."]);
    r.git(r.work, ["commit", "-q", "-m", "agent work"], {
      ...datedNow(),
      GIT_COMMITTER_EMAIL: AGENT_EMAIL,
    });
    r.git(r.work, ["push", "-q", "origin", "main"]);
    await handle.api.handleHook(hook("Stop", r.work));
    await handle.tick();
    expect(listed(handle)).toEqual([["agent.txt"]]);
  });

  it("counts only the session's lines in a file that already held edits, and drops the copy with the session", async () => {
    const r = rig();
    writeFileSync(join(r.work, "a.txt"), "one\ntwo\nthree\nperson\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const paths = scratchPaths();
    const handle = await boot(r.exec, paths);
    await handle.api.handleHook(hook("SessionStart", r.work));
    await handle.tick();
    writeFileSync(join(r.work, "a.txt"), "one\ntwo\nthree\nperson\nsession\n");
    await handle.api.handleHook(hook("Stop", r.work));
    await handle.tick();

    const [frame] = reconciliations(handle);
    expect(
      (frame?.body as { observed_changes: unknown[] }).observed_changes,
    ).toMatchObject([
      { repo_relative_path: "a.txt", lines_added: 1, lines_removed: 0 },
    ]);
    expect(frame?.attrs).toMatchObject({
      pre_session_changes: "excluded",
      pre_session_edit_counts: "session_only",
    });
    const uuid = handle.registry.get(SESSION)?.recorder.sessionUuid ?? "";
    const copies = join(paths.preSessionCopies, uuid);
    expect(readdirSync(copies)).toHaveLength(1);

    // Once the daemon forgets the sealed session, its copy goes too.
    await handle.api.handleHook(hook("SessionEnd", r.work));
    await handle.tick();
    await handle.tick();
    expect(handle.registry.forgetSealed(-1)).toEqual([SESSION]);
    await handle.tick();
    expect(existsSync(copies)).toBe(false);
  });

  it("reports a file written before a replayed SessionStart reached the daemon", async () => {
    const r = rig();
    // The daemon is down as the session starts. The hook spools the
    // SessionStart, and the agent writes a file before the daemon returns.
    const receivedAt = toProtocolTimestamp(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(
      join(r.work, "early.txt"),
      "written while the daemon was down\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const handle = await boot(r.exec);
    await handle.api.handleHook({
      ...hook("SessionStart", r.work),
      replay: { receivedAt },
    });
    await handle.tick();
    await handle.api.handleHook(hook("Stop", r.work));
    await handle.tick();
    expect(listed(handle)).toEqual([["early.txt"]]);
  });

  it("keeps the files of a squash-merged branch across a restart", async () => {
    const r = rig();
    const paths = scratchPaths();
    const first = await boot(r.exec, paths);
    await first.api.handleHook(hook("SessionStart", r.work));
    await first.tick();
    r.git(r.work, ["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(r.work, "feature.txt"), "x\ny\nz\n");
    r.git(r.work, ["add", "."]);
    r.git(r.work, ["commit", "-q", "-m", "feature"], datedNow());
    await first.api.handleHook(hook("Stop", r.work));
    await first.tick();
    expect(listed(first)).toEqual([["feature.txt"]]);

    // The squash commit carries the forge's email, and the session's own
    // commit leaves main's history. Only the commits the lane kept in
    // daemon.json still name the file after the restart.
    squashMergeAndPull(r, "feature.txt", "x\ny\nz\n");
    await stop(first);
    const second = await boot(r.exec, paths);
    await second.api.handleHook(hook("Stop", r.work));
    await second.tick();
    expect(listed(second)).toEqual([["feature.txt"]]);
  });
});
