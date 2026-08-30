/**
 * Git isolation protocol — proven against a *real* temp git repo, because the
 * whole point is the actual git behavior, not a mock of it. We assert the four
 * guarantees the fleet relies on:
 *
 *   1. No clobber — two agents editing the same file in their own worktrees
 *      never see each other's writes.
 *   2. Atomic + pinned — every checkpoint is one commit, pinned under
 *      `refs/oxagen/agents/*` so it survives branch deletion and gc.
 *   3. Conflicts surface, never corrupt — an overlapping merge is aborted, the
 *      integration tree stays clean, and the losing branch is still recoverable.
 *   4. Durable log — cleanup removes worktrees but keeps the pins.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "../fleet/git-isolation.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "oxa-iso-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "t@oxagen.dev");
  git(repo, "config", "user.name", "Isolation Test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "base.txt"), "original\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("WorktreeManager", () => {
  it("isolates parallel agents — same-file edits never clobber, both pinned", async () => {
    const mgr = new WorktreeManager({ repoRoot: repo, namespace: "p1" });
    const a = await mgr.spawn("task-a");
    const b = await mgr.spawn("task-b");
    expect(a).not.toBe(b);

    // Both agents edit the SAME path — but in their own trees.
    writeFileSync(join(a, "shared.txt"), "from A\n");
    writeFileSync(join(b, "shared.txt"), "from B\n");

    const cpA = await mgr.checkpoint("task-a", "a writes shared");
    const cpB = await mgr.checkpoint("task-b", "b writes shared");

    // No clobber: each worktree kept its own content.
    expect(readFileSync(join(a, "shared.txt"), "utf8")).toBe("from A\n");
    expect(readFileSync(join(b, "shared.txt"), "utf8")).toBe("from B\n");

    // Atomic + pinned: one commit each, both reachable under refs/oxagen/agents.
    expect(cpA?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(cpB?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(cpA!.hash).not.toBe(cpB!.hash);
    const pins = git(
      repo,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/oxagen/agents",
    );
    expect(pins).toContain(cpA!.hash);
    expect(pins).toContain(cpB!.hash);
  });

  it("checkpoint returns null when the agent changed nothing", async () => {
    const mgr = new WorktreeManager({ repoRoot: repo, namespace: "p2" });
    await mgr.spawn("noop");
    expect(await mgr.checkpoint("noop", "nothing")).toBeNull();
  });

  it("integrates non-overlapping work cleanly", async () => {
    const mgr = new WorktreeManager({ repoRoot: repo, namespace: "p3" });

    const a = await mgr.spawn("a");
    writeFileSync(join(a, "a.txt"), "a\n");
    await mgr.checkpoint("a", "add a.txt");
    const rA = await mgr.integrate("a");
    expect(rA.ok).toBe(true);

    const b = await mgr.spawn("b");
    writeFileSync(join(b, "b.txt"), "b\n");
    await mgr.checkpoint("b", "add b.txt");
    const rB = await mgr.integrate("b");
    expect(rB.ok).toBe(true);

    // The integration tree has both agents' files.
    const int = mgr.integrationRef()!;
    expect(existsSync(join(int.path, "a.txt"))).toBe(true);
    expect(existsSync(join(int.path, "b.txt"))).toBe(true);
  });

  it("surfaces a conflict, aborts clean, and keeps the losing work recoverable", async () => {
    const mgr = new WorktreeManager({ repoRoot: repo, namespace: "p4" });

    // A and B both rewrite base.txt from the same frozen base → real conflict.
    const a = await mgr.spawn("a");
    writeFileSync(join(a, "base.txt"), "A version\n");
    await mgr.checkpoint("a", "a edits base");
    const rA = await mgr.integrate("a");
    expect(rA.ok).toBe(true);
    const intTipAfterA = git(repo, "rev-parse", mgr.integrationRef()!.branch);

    const b = await mgr.spawn("b");
    writeFileSync(join(b, "base.txt"), "B version\n");
    const cpB = await mgr.checkpoint("b", "b edits base");
    const rB = await mgr.integrate("b");

    // Conflict surfaced, not silently merged.
    expect(rB.ok).toBe(false);
    expect(rB.conflicts).toContain("base.txt");

    // Integration tree stayed clean (merge --abort) and branch is unchanged.
    const int = mgr.integrationRef()!;
    expect(git(int.path, "status", "--porcelain")).toBe("");
    expect(git(repo, "rev-parse", int.branch)).toBe(intTipAfterA);

    // The losing work is NOT lost — recoverable by its pinned tip.
    expect(rB.taskTip).toBe(cpB!.hash);
    expect(git(repo, "cat-file", "-t", rB.taskTip!)).toBe("commit");
    expect(git(repo, "show", `${rB.taskTip}:base.txt`)).toBe("B version");
  });

  it("cleanupAll removes worktrees but keeps the durability pins", async () => {
    const mgr = new WorktreeManager({ repoRoot: repo, namespace: "p5" });
    const a = await mgr.spawn("a");
    writeFileSync(join(a, "a.txt"), "a\n");
    const cp = await mgr.checkpoint("a", "add a.txt");

    await mgr.cleanupAll();

    expect(existsSync(a)).toBe(false); // worktree gone
    // Pin survives — the commit is still reachable by hash.
    const pins = git(
      repo,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/oxagen/agents",
    );
    expect(pins).toContain(cp!.hash);
    expect(git(repo, "cat-file", "-t", cp!.hash)).toBe("commit");
  });
});
