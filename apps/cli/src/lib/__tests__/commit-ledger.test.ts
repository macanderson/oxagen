/**
 * commit-ledger tests — the "never lose work" primitive.
 *
 * Uses a real temp git repo (fast, no network) + an OXAGEN_COMMIT_LEDGER
 * override so nothing touches the real ~/.oxagen ledger.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitWork,
  readLedger,
  recordCommit,
  commitExists,
  ledgerPath,
} from "../commit-ledger.js";

let repo: string;
let ledger: string;
const origEnv = process.env["OXAGEN_COMMIT_LEDGER"];

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "oxagen-ledger-repo-"));
  ledger = join(mkdtempSync(join(tmpdir(), "oxagen-ledger-")), "ledger.jsonl");
  process.env["OXAGEN_COMMIT_LEDGER"] = ledger;
  git(["init", "-q"], repo);
  git(["config", "user.email", "t@t.local"], repo);
  git(["config", "user.name", "t"], repo);
  writeFileSync(join(repo, "seed.txt"), "seed");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "seed"], repo);
});

afterEach(() => {
  if (origEnv === undefined) delete process.env["OXAGEN_COMMIT_LEDGER"];
  else process.env["OXAGEN_COMMIT_LEDGER"] = origEnv;
  rmSync(repo, { recursive: true, force: true });
});

describe("ledgerPath", () => {
  it("honors the OXAGEN_COMMIT_LEDGER override", () => {
    expect(ledgerPath()).toBe(ledger);
  });
});

describe("commitWork", () => {
  it("commits with --no-verify, returns the hash, and records a ledger entry", () => {
    writeFileSync(join(repo, "a.py"), "print(1)\n");
    const res = commitWork(repo, "add a.py", { taskId: "T1", traceId: "turn_x" });

    expect(res.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(res.recorded).toBe(true);
    expect(res.files).toContain("a.py");

    const entries = readLedger();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      hash: res.hash,
      cwd: repo,
      message: "add a.py",
      taskId: "T1",
      traceId: "turn_x",
    });
    expect(entries[0]?.files).toContain("a.py");
    // The commit really exists in the repo.
    expect(git(["rev-parse", "HEAD"], repo)).toBe(res.hash);
  });

  it("is a no-op on a clean tree (hash null, nothing recorded)", () => {
    const res = commitWork(repo, "nothing to do");
    expect(res.hash).toBeNull();
    expect(res.recorded).toBe(false);
    expect(readLedger()).toHaveLength(0);
  });

  it("skips hooks (commits even when a failing pre-commit hook is installed)", () => {
    const hookDir = join(repo, ".git", "hooks");
    writeFileSync(join(hookDir, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    writeFileSync(join(repo, "b.py"), "print(2)\n");
    const res = commitWork(repo, "add b despite failing hook");
    expect(res.hash).toMatch(/^[0-9a-f]{40}$/); // --no-verify bypassed the hook
  });
});

describe("readLedger", () => {
  it("returns entries newest-first and filters by cwd/task", () => {
    recordCommit({ hash: "h1", branch: "b", cwd: "/repoA", message: "one", files: [], at: "2026-01-01T00:00:00Z", taskId: "A" });
    recordCommit({ hash: "h2", branch: "b", cwd: "/repoB", message: "two", files: [], at: "2026-01-02T00:00:00Z", taskId: "B" });
    recordCommit({ hash: "h3", branch: "b", cwd: "/repoA", message: "three", files: [], at: "2026-01-03T00:00:00Z", taskId: "A" });

    const all = readLedger();
    expect(all.map((e) => e.hash)).toEqual(["h3", "h2", "h1"]); // newest first
    const repoA = readLedger({ cwd: "/repoA" });
    expect(repoA.map((e) => e.hash)).toEqual(["h3", "h1"]);
    const taskB = readLedger({ taskId: "B" });
    expect(taskB.map((e) => e.hash)).toEqual(["h2"]);
    expect(readLedger({ limit: 1 }).map((e) => e.hash)).toEqual(["h3"]);
  });

  it("skips malformed lines instead of losing the whole ledger", () => {
    recordCommit({ hash: "good", branch: "", cwd: "/r", message: "ok", files: [], at: "2026-01-01T00:00:00Z" });
    // Corrupt append.
    execFileSync("sh", ["-c", `printf 'not json\\n{bad\\n' >> ${JSON.stringify(ledger)}`]);
    const entries = readLedger();
    expect(entries.map((e) => e.hash)).toContain("good");
    expect(entries).toHaveLength(1);
  });

  it("returns [] when the ledger does not exist", () => {
    process.env["OXAGEN_COMMIT_LEDGER"] = join(tmpdir(), "definitely-missing-ledger-xyz.jsonl");
    expect(existsSync(process.env["OXAGEN_COMMIT_LEDGER"])).toBe(false);
    expect(readLedger()).toEqual([]);
  });
});

describe("commitExists", () => {
  it("is true for a real commit and false for a bogus hash", () => {
    writeFileSync(join(repo, "x.py"), "1");
    const res = commitWork(repo, "x", {});
    writeFileSync(join(repo, "c.py"), "3");
    const r2 = commitWork(repo, "c", {});
    expect(commitExists(r2.hash as string, repo)).toBe(true);
    expect(commitExists("0000000000000000000000000000000000000000", repo)).toBe(false);
    // ledger recorded both, newest first
    expect(readLedger().map((e) => e.hash)).toEqual([r2.hash, res.hash]);
  });
});
