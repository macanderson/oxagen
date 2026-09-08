/**
 * The guard for #2730's root cause.
 *
 * A push to main sharing a concurrency group with the push behind it is what
 * let eight commits reach main undeployed on 2026-09-07: GitHub keeps one
 * queued run per group, so each merge evicted the run waiting before it and
 * none ever started. Deploys need a passing check, and cancelled runs read as
 * ordinary cleanup — so nothing went red while nothing shipped.
 */
import { describe, expect, it } from "vitest";
import {
  concurrencyGroup,
  isPerCommitOnMain,
} from "./check-main-concurrency.mjs";

const PER_COMMIT = `concurrency:
  # a comment that must not be read as the group
  group: >-
    ci-\${{ github.ref }}\${{
      github.event_name == 'push' && github.ref == 'refs/heads/main'
        && format('-{0}', github.sha) || ''
    }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
`;

const SHARED = `concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
`;

describe("concurrencyGroup", () => {
  it("reads a folded group and drops the comments", () => {
    const g = concurrencyGroup(PER_COMMIT);
    expect(g).toContain("github.sha");
    // The comment line must not leak into the value — it would make every
    // check pass for the wrong reason if it happened to mention github.sha.
    expect(g).not.toContain("must not be read");
    expect(g).not.toContain("cancel-in-progress");
  });

  it("reads a plain one-line group", () => {
    expect(concurrencyGroup(SHARED)).toBe("ci-${{ github.ref }}");
  });

  it("returns null when there is no concurrency block", () => {
    expect(concurrencyGroup("jobs:\n  build:\n    runs-on: x\n")).toBeNull();
  });
});

describe("isPerCommitOnMain", () => {
  it("accepts the per-commit group", () => {
    expect(isPerCommitOnMain(concurrencyGroup(PER_COMMIT))).toBe(true);
  });

  it("rejects the shared group that caused #2730", () => {
    // The witness: this is what shipped before the fix.
    expect(isPerCommitOnMain(concurrencyGroup(SHARED))).toBe(false);
  });

  it("rejects a group that mentions the sha but not a push to main", () => {
    // A guard that only looked for `github.sha` would pass a group keyed on it
    // for pull requests, which is the opposite of what is wanted there.
    expect(isPerCommitOnMain("ci-${{ github.sha }}")).toBe(false);
  });

  it("rejects a missing group", () => {
    expect(isPerCommitOnMain(null)).toBe(false);
  });
});
