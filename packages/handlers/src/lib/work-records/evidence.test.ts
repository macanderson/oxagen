// A send's pull request evidence as provider facts (ADR-250). The cases that
// matter most: a failed required-checks read never yields "none required", and
// a re-read records nothing new while a real change does.
import { describe, expect, it } from "vitest";
import type { GitHubCiChecks } from "@oxagen/github";
import { evidenceFacts, observedChecksOf, type PullRequestRead } from "./evidence";

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const MERGE = "9".repeat(40);
const NOW = "2026-10-02T10:00:00.000Z";

const run = (name: string, status: "queued" | "in_progress" | "completed", conclusion: string | null, completedAt: string | null = null) =>
  ({ name, status, conclusion, detailsUrl: null, startedAt: "2026-10-02T09:00:00.000Z", completedAt, appName: null }) as GitHubCiChecks["checkRuns"][number];

const checks = (checkRuns: GitHubCiChecks["checkRuns"], statuses: GitHubCiChecks["statuses"] = []): GitHubCiChecks => ({ sha: SHA1, checkRuns, statuses, complete: true });

const pull = (over: Partial<PullRequestRead> = {}): PullRequestRead => ({
  headSha: SHA1,
  baseRef: "main",
  state: "open",
  merged: false,
  mergeCommitSha: null,
  mergedAt: null,
  updatedAt: "2026-10-02T09:30:00.000Z",
  ...over,
});

const ORDER = { orderId: "o1", pullRequest: { repository: "aintel/platform", number: 612 }, head: SHA1, requiredChecks: null };

describe("observedChecksOf", () => {
  it("reads an unfinished check run as pending", () => {
    expect(observedChecksOf(checks([run("test", "in_progress", null)]))).toEqual([{ name: "test", conclusion: "pending", at: "2026-10-02T09:00:00.000Z" }]);
  });

  it("keeps the latest run of a re-run check", () => {
    const read = observedChecksOf(
      checks([run("test", "completed", "failure", "2026-10-02T09:10:00.000Z"), run("test", "completed", "success", "2026-10-02T09:20:00.000Z")]),
    );
    expect(read).toEqual([{ name: "test", conclusion: "success", at: "2026-10-02T09:20:00.000Z" }]);
  });

  it("reads a status error as a failure, and a disagreement as the less successful report", () => {
    const read = observedChecksOf(
      checks([run("ci", "completed", "success", "2026-10-02T09:10:00.000Z")], [
        { context: "ci", state: "error", targetUrl: null, createdAt: null, updatedAt: "2026-10-02T09:11:00.000Z" },
        { context: "lint", state: "success", targetUrl: null, createdAt: null, updatedAt: null },
      ]),
    );
    expect(read).toEqual([
      { name: "ci", conclusion: "failure", at: "2026-10-02T09:11:00.000Z" },
      { name: "lint", conclusion: "success", at: null },
    ]);
  });
});

describe("evidenceFacts", () => {
  it("records nothing for a send with no pull request", () => {
    const { facts, summary } = evidenceFacts({ ...ORDER, pullRequest: null }, { pull: null, required: null, checks: null }, NOW);
    expect(facts).toEqual([]);
    expect(summary.unreadReason).toBe("no pull request");
  });

  it("never records a required list from a failed read", () => {
    const { facts, summary } = evidenceFacts(ORDER, { pull: pull(), required: { ok: false, reason: "rulesets read failed: 404" }, checks: checks([]) }, NOW);
    expect(facts.some((fact) => fact.kind === "checks_required")).toBe(false);
    expect(summary).toEqual({ head: SHA1, requiredChecks: null, unreadReason: "rulesets read failed: 404" });
  });

  it("records an empty required list only from a read that succeeded", () => {
    const { facts, summary } = evidenceFacts(ORDER, { pull: pull(), required: { ok: true, names: [], sources: { protection: false, rulesets: false } }, checks: checks([]) }, NOW);
    expect(summary.requiredChecks).toEqual([]);
    expect(facts.filter((fact) => fact.kind === "checks_required").map((fact) => fact.data)).toEqual([{ names: [] }]);
  });

  it("records the required list again only when it changed for the head", () => {
    const read = { pull: pull(), required: { ok: true as const, names: ["test", "e2e"], sources: { protection: true, rulesets: false } }, checks: null };
    const same = evidenceFacts({ ...ORDER, requiredChecks: ["e2e", "test"] }, read, NOW);
    expect(same.facts.some((fact) => fact.kind === "checks_required")).toBe(false);
    const changed = evidenceFacts({ ...ORDER, requiredChecks: ["test"] }, read, NOW);
    expect(changed.facts.filter((fact) => fact.kind === "checks_required")).toHaveLength(1);
  });

  it("records a new head, and reads its checks under it", () => {
    const { facts } = evidenceFacts(ORDER, { pull: pull({ headSha: SHA2 }), required: null, checks: checks([run("test", "completed", "success", "2026-10-02T09:40:00.000Z")]) }, NOW);
    expect(facts.map((fact) => [fact.kind, fact.headSha])).toEqual([
      ["head_observed", SHA2],
      ["check_observed", SHA2],
    ]);
  });

  it("names a check's conclusion and time in its key, so a flip back is recorded again", () => {
    const success = evidenceFacts(ORDER, { pull: pull(), required: null, checks: checks([run("test", "completed", "success", "2026-10-02T09:20:00.000Z")]) }, NOW).facts;
    const again = evidenceFacts(ORDER, { pull: pull(), required: null, checks: checks([run("test", "completed", "success", "2026-10-02T09:50:00.000Z")]) }, NOW).facts;
    const repeat = evidenceFacts(ORDER, { pull: pull(), required: null, checks: checks([run("test", "completed", "success", "2026-10-02T09:20:00.000Z")]) }, NOW).facts;
    expect(success[0]?.dedupeKey).not.toBe(again[0]?.dedupeKey);
    expect(success[0]?.dedupeKey).toBe(repeat[0]?.dedupeKey);
  });

  it("records a human merge with its merge commit, and a close without merging", () => {
    const merged = evidenceFacts(ORDER, { pull: pull({ state: "closed", merged: true, mergeCommitSha: MERGE, mergedAt: "2026-10-02T09:45:00.000Z" }), required: null, checks: null }, NOW).facts;
    expect(merged.find((fact) => fact.kind === "merged")).toMatchObject({ headSha: SHA1, data: { merge_commit: MERGE }, occurredAt: "2026-10-02T09:45:00.000Z" });
    const closed = evidenceFacts(ORDER, { pull: pull({ state: "closed" }), required: null, checks: null }, NOW).facts;
    expect(closed.map((fact) => fact.kind)).toEqual(["pr_closed"]);
  });

  it("files every fact as the provider's, on the send", () => {
    const { facts } = evidenceFacts(ORDER, { pull: pull({ headSha: SHA2 }), required: { ok: true, names: ["test"], sources: { protection: true, rulesets: false } }, checks: checks([run("test", "completed", "failure", "2026-10-02T09:40:00.000Z")]) }, NOW);
    for (const fact of facts) expect(fact).toMatchObject({ source: "provider", orderId: "o1", repository: "aintel/platform", prNumber: 612 });
  });
});
