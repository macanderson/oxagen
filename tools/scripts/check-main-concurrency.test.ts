/**
 * The guard for ADR-287: pushes to main share one concurrency group, and
 * nothing cancels a running main run.
 *
 * Each shape it refuses has a witness here. The per-commit group is what ran
 * from 2026-09-07 to 2026-10-02 (ADR-046): every merge paid the full gate
 * (#5248), and parallel main runs let an older commit deploy after a newer
 * commit's migration (#5247). Cancelling a running main run would cut
 * `migration-gate` off mid-apply. A group that lets a manual dispatch share
 * the push group lets the dispatch replace a waiting push run.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  cancelInProgress,
  concurrencyGroup,
  concurrencyProblems,
} from "./check-main-concurrency.mjs";

const SHARED_PUSH = `concurrency:
  # a comment that must not be read as the group, even one naming github.sha
  group: >-
    ci-\${{ github.ref }}\${{
      github.event_name == 'push' && github.ref == 'refs/heads/main'
        && '-push' || ''
    }}
  # a comment between the keys
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
`;

const PER_COMMIT = `concurrency:
  group: >-
    ci-\${{ github.ref }}\${{
      github.event_name == 'push' && github.ref == 'refs/heads/main'
        && format('-{0}', github.sha) || ''
    }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
`;

const BY_REF_ONLY = `concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
`;

const problemsOf = (yaml: string) =>
  concurrencyProblems(concurrencyGroup(yaml), cancelInProgress(yaml));

describe("concurrencyGroup", () => {
  it("reads a folded group and drops the comments", () => {
    const g = concurrencyGroup(SHARED_PUSH);
    expect(g).toContain("'-push'");
    // The comment line must not leak into the value: it mentions github.sha
    // and would make the per-commit check fail for the wrong reason.
    expect(g).not.toContain("must not be read");
    expect(g).not.toContain("cancel-in-progress");
  });

  it("reads a plain one-line group", () => {
    expect(concurrencyGroup(BY_REF_ONLY)).toBe("ci-${{ github.ref }}");
  });

  it("returns null when there is no concurrency block", () => {
    expect(concurrencyGroup("jobs:\n  build:\n    runs-on: x\n")).toBeNull();
  });
});

describe("cancelInProgress", () => {
  it("reads the value past a comment line", () => {
    expect(cancelInProgress(SHARED_PUSH)).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
  });

  it("returns null when the key is missing", () => {
    expect(cancelInProgress("concurrency:\n  group: ci\n")).toBeNull();
  });
});

describe("concurrencyProblems", () => {
  it("accepts one shared group for pushes to main", () => {
    expect(problemsOf(SHARED_PUSH)).toEqual([]);
  });

  it("accepts cancel-in-progress set to false", () => {
    const off = SHARED_PUSH.replace(
      /cancel-in-progress: .*/,
      "cancel-in-progress: false",
    );
    expect(problemsOf(off)).toEqual([]);
  });

  it("rejects the per-commit group ADR-046 shipped", () => {
    expect(problemsOf(PER_COMMIT)).toEqual([
      expect.stringMatching(/keyed by github\.sha/),
    ]);
  });

  it("rejects a group that lets a manual dispatch share the push group", () => {
    expect(problemsOf(BY_REF_ONLY)).toEqual([
      expect.stringMatching(/manual dispatch/),
    ]);
  });

  it("rejects cancelling a running main run", () => {
    const always = SHARED_PUSH.replace(
      /cancel-in-progress: .*/,
      "cancel-in-progress: true",
    );
    expect(problemsOf(always)).toEqual([
      expect.stringMatching(/cancel-in-progress is true/),
    ]);
    const pushes = SHARED_PUSH.replace(
      /cancel-in-progress: .*/,
      "cancel-in-progress: ${{ github.event_name == 'push' }}",
    );
    expect(problemsOf(pushes)).toEqual([
      expect.stringMatching(/cancel-in-progress is/),
    ]);
  });

  it("rejects a missing group and a missing cancel-in-progress", () => {
    expect(concurrencyProblems(null, null)).toEqual([
      expect.stringMatching(/no `group:`/),
      expect.stringMatching(/cancel-in-progress is missing/),
    ]);
  });

  it("passes the real pipeline", () => {
    const pipeline = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        ".github",
        "workflows",
        "pipeline.yml",
      ),
      "utf8",
    );
    expect(problemsOf(pipeline)).toEqual([]);
  });
});
