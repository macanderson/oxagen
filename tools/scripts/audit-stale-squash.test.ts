import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditBaselines,
  collectBaselines,
  missingContent,
} from "./audit-stale-squash.mjs";

import { runCheck } from "./check-stale-merge-base.mjs";

const repos: string[] = [];
function repository() {
  const cwd = mkdtempSync(join(tmpdir(), "squash-forensics-"));
  repos.push(cwd);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Audit fixture");
  git("config", "user.email", "audit@example.test");
  const commit = (file: string, text: string) => {
    writeFileSync(join(cwd, file), text);
    git("add", ".");
    git("commit", "-m", file);
    return git("rev-parse", "HEAD");
  };
  commit("gate.ts", "deny\n");
  return { cwd, git, commit };
}
afterEach(() => {
  for (const cwd of repos.splice(0))
    rmSync(cwd, { recursive: true, force: true });
});

describe("historical squash audit", () => {
  it("the live overlap advisory includes a branch deletion", () => {
    const { cwd, git, commit } = repository();
    git("branch", "topic");
    commit("gate.ts", "deny\ncli exemption\n");
    git("checkout", "topic");
    git("rm", "gate.ts");
    git("commit", "-m", "remove gate");
    expect(
      runCheck({ cwd, branchRef: "topic", mainRef: "main" }).files,
    ).toEqual([expect.objectContaining({ path: "gate.ts", atRisk: true })]);
  });

  it("records removed protections restored by a later result", () => {
    expect(missingContent("permit all\n", "deny\n", "permit all\n")).toEqual({
      lostMainLines: ["deny"],
      restoredRemovedLines: ["permit all"],
    });
  });
  it("finds a non-adjacent fix lost in the final squash", () => {
    const { cwd, git, commit } = repository();
    git("branch", "topic");
    commit("gate.ts", "deny\ncli exemption\n");
    commit("unrelated.ts", "unrelated\n");
    const main = git("rev-parse", "HEAD");
    git("checkout", "topic");
    const head = commit("gate.ts", "deny\nbranch change\n");
    git("checkout", "main");
    const merge = commit("gate.ts", "deny\nbranch change\n");
    const baselines = collectBaselines({
      cwd,
      tip: merge,
      prs: [{ number: 1, headRefOid: head, mergeCommit: { oid: merge } }],
    });
    expect(baselines.records[0]?.incoming).toBe(main);
    expect(auditBaselines({ cwd, baselines })).toEqual([
      expect.objectContaining({
        kind: "squash",
        path: "gate.ts",
        lostMainLines: ["cli exemption"],
      }),
    ]);
  });

  it("finds a bad integration even when the final PR contains current main", () => {
    const { cwd, git, commit } = repository();
    git("branch", "topic");
    const incoming = commit("gate.ts", "deny\ncli exemption\n");
    git("checkout", "topic");
    commit("topic.ts", "topic\n");
    git("merge", "-s", "ours", "main", "-m", "incorrect resolution");
    const head = git("rev-parse", "HEAD");
    git("checkout", "main");
    git("merge", "--squash", "topic");
    git("commit", "-m", "squash topic");
    const merge = git("rev-parse", "HEAD");
    const baselines = collectBaselines({
      cwd,
      tip: merge,
      prs: [{ number: 2, headRefOid: head, mergeCommit: { oid: merge } }],
    });
    expect(baselines.records[0]?.base).toBe(incoming);
    expect(auditBaselines({ cwd, baselines })).toEqual([
      expect.objectContaining({
        kind: "branch-integration",
        merge: head,
        lostMainLines: ["cli exemption"],
      }),
    ]);
  });

  it("does not call an untouched old file a loss after a clean squash", () => {
    const { cwd, git, commit } = repository();
    git("branch", "topic");
    commit("gate.ts", "deny\ncli exemption\n");
    git("checkout", "topic");
    const head = commit("topic.ts", "topic\n");
    git("checkout", "main");
    git("merge", "--squash", "topic");
    git("commit", "-m", "squash topic");
    const merge = git("rev-parse", "HEAD");
    expect(git("show", "HEAD:gate.ts")).toContain("cli exemption");
    expect(
      auditBaselines({
        cwd,
        baselines: collectBaselines({
          cwd,
          tip: merge,
          prs: [{ number: 3, headRefOid: head, mergeCommit: { oid: merge } }],
        }),
      }),
    ).toEqual([]);
  });

  it("includes deleted files and refuses missing retained heads", () => {
    const { cwd, git, commit } = repository();
    const base = git("rev-parse", "HEAD");
    const incoming = commit("gate.ts", "deny\ncli exemption\n");
    git("rm", "gate.ts");
    git("commit", "-m", "remove gate");
    const result = git("rev-parse", "HEAD");
    expect(
      auditBaselines({
        cwd,
        baselines: {
          tip: result,
          records: [{ kind: "squash", base, incoming, result }],
        },
      })[0],
    ).toMatchObject({ path: "gate.ts", lostMainLines: ["cli exemption"] });
    expect(() =>
      collectBaselines({
        cwd,
        tip: result,
        prs: [
          {
            number: 4,
            headRefOid: "missing-head",
            mergeCommit: { oid: result },
          },
        ],
      }),
    ).toThrow();
  });
});
