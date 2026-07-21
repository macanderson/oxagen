import { describe, it, expect } from "vitest";
import {
  toNaturalKey,
  codeScopeNaturalKey,
  repositoryNaturalKey,
  repositorySnapshotNaturalKey,
} from "./natural-key";

describe("toNaturalKey (canonical SourceFile identity)", () => {
  it("builds github:{owner}/{repo}:{path} — NO connectionId (a repo reached via two connections is one repo)", () => {
    expect(toNaturalKey("src/auth.ts", "acme", "api")).toBe(
      "github:acme/api:src/auth.ts",
    );
  });

  it("normalises a leading slash so /src/a.ts and src/a.ts key the same node", () => {
    expect(toNaturalKey("/src/a.ts", "acme", "api")).toBe(
      "github:acme/api:src/a.ts",
    );
    expect(toNaturalKey("/src/a.ts", "acme", "api")).toBe(
      toNaturalKey("src/a.ts", "acme", "api"),
    );
  });

  it("falls back to the raw path when owner/repo are absent", () => {
    expect(toNaturalKey("src/a.ts", undefined, undefined)).toBe("src/a.ts");
  });
});

describe("scope / repository / snapshot keys", () => {
  it("codeScopeNaturalKey → github:{owner}/{repo}:scope:{scopeKey}", () => {
    expect(codeScopeNaturalKey("acme", "api", "packages/billing")).toBe(
      "github:acme/api:scope:packages/billing",
    );
  });

  it("repositoryNaturalKey → github:repo:{providerRepoId}", () => {
    expect(repositoryNaturalKey("123456")).toBe("github:repo:123456");
  });

  it("repositorySnapshotNaturalKey → github:repo:{providerRepoId}:snapshot:{commitSha}", () => {
    expect(repositorySnapshotNaturalKey("123456", "abc123")).toBe(
      "github:repo:123456:snapshot:abc123",
    );
  });
});

// ── Cross-producer identity (spec finding 4 — the whole point of unification) ──
//
// The three producers of a SourceFile naturalKey must be byte-identical for the
// same (owner, repo, path), or a run's TOUCHED_FILE edge lands on a different
// node than the one GitHub ingestion projected:
//   1. GitHub ingestion (ingestion.github-parse-file) writes the literal
//      `github:${owner}/${repo}:${path}`.
//   2. The file-lock adapters call toNaturalKey(path, owner, repo).
//   3. record-execution's touchedFilePaths are toNaturalKey(path, owner, repo).
// This asserts all three collapse to one string.
describe("cross-producer SourceFile identity is unified", () => {
  const owner = "acme";
  const repo = "api";
  const path = "src/auth.ts";

  // The literal string ingestion.github-parse-file interpolates for its
  // `MERGE (:SourceFile { naturalKey })`.
  const ingestionKey = `github:${owner}/${repo}:${path}`;

  it("ingestion literal === file-lock/record-execution toNaturalKey output", () => {
    expect(toNaturalKey(path, owner, repo)).toBe(ingestionKey);
  });

  it("the IN_SCOPE target and the BINDS_SCOPE node share one scope key", () => {
    // parse-file's IN_SCOPE edge target and project-snapshot's CodeScope node
    // both derive from codeScopeNaturalKey — same node, no orphan scope.
    const scopeKey = "packages/billing";
    expect(codeScopeNaturalKey(owner, repo, scopeKey)).toBe(
      `github:${owner}/${repo}:scope:${scopeKey}`,
    );
  });
});
