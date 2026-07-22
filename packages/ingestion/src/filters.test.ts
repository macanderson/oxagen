/**
 * Unit tests for the ingestion filter utilities.
 *
 * Tests are isolated — no external deps, no mocks required.
 */

import { describe, it, expect } from "vitest";
import {
  matchGlobPattern,
  applyRecordTypeFilter,
  applyPathFilter,
  applyLabelFilter,
  shouldRunInference,
  type DeliveryConfig,
} from "./filters";

// ── matchGlobPattern ──────────────────────────────────────────────────────────

describe("matchGlobPattern", () => {
  it("returns false for empty patterns list", () => {
    expect(matchGlobPattern("node_modules/foo.ts", [])).toBe(false);
  });

  it("matches ** glob — any depth path", () => {
    expect(
      matchGlobPattern("node_modules/foo/bar.ts", ["node_modules/**"]),
    ).toBe(true);
    expect(matchGlobPattern("dist/index.js", ["dist/**"])).toBe(true);
  });

  it("matches * glob — single segment, no slashes", () => {
    expect(matchGlobPattern("package-lock.json", ["*.lock"])).toBe(false); // .lock not .json
    expect(matchGlobPattern("yarn.lock", ["*.lock"])).toBe(true);
    expect(matchGlobPattern("pnpm-lock.yaml", ["*.lock"])).toBe(false);
  });

  it("matches .lock extension with *", () => {
    expect(matchGlobPattern("yarn.lock", ["*.lock"])).toBe(true);
    expect(matchGlobPattern("pnpm-lock.yaml", ["*.lock"])).toBe(false);
  });

  it("matches literal patterns exactly", () => {
    expect(matchGlobPattern("README.md", ["README.md"])).toBe(true);
    expect(matchGlobPattern("readme.md", ["README.md"])).toBe(false); // case-sensitive
  });

  it("** matches single segment too", () => {
    expect(matchGlobPattern("dist/bundle.js", ["dist/**"])).toBe(true);
    expect(matchGlobPattern("coverage/lcov.info", ["coverage/**"])).toBe(true);
  });

  it("** at root matches nested paths", () => {
    expect(matchGlobPattern("a/b/c/d.ts", ["**"])).toBe(true);
    expect(matchGlobPattern("a/b/c/d.ts", ["a/**"])).toBe(true);
    expect(matchGlobPattern("b/c/d.ts", ["a/**"])).toBe(false);
  });

  it("? matches exactly one non-slash character", () => {
    expect(matchGlobPattern("src/a.ts", ["src/?.ts"])).toBe(true);
    expect(matchGlobPattern("src/ab.ts", ["src/?.ts"])).toBe(false);
    expect(matchGlobPattern("src/a/b.ts", ["src/?.ts"])).toBe(false);
  });

  it("returns true when ANY pattern matches", () => {
    expect(
      matchGlobPattern("node_modules/react/index.js", [
        "dist/**",
        "node_modules/**",
        ".git/**",
      ]),
    ).toBe(true);
  });

  it("returns false when no pattern matches", () => {
    expect(
      matchGlobPattern("src/components/Button.tsx", [
        "node_modules/**",
        "dist/**",
        "*.lock",
      ]),
    ).toBe(false);
  });

  it("handles special regex characters in literal segments", () => {
    // Dot in extension should be a literal dot, not a regex wildcard
    expect(matchGlobPattern("filets", ["file.ts"])).toBe(false);
    expect(matchGlobPattern("file.ts", ["file.ts"])).toBe(true);
  });
});

// ── applyRecordTypeFilter ─────────────────────────────────────────────────────

describe("applyRecordTypeFilter", () => {
  it("passes all records when allowedTypes is empty", () => {
    const result = applyRecordTypeFilter("pull_request", []);
    expect(result.filtered).toBe(false);
  });

  it("passes a record when its type is in the allow list", () => {
    const result = applyRecordTypeFilter("issue", ["pull_request", "issue"]);
    expect(result.filtered).toBe(false);
  });

  it("filters a record when its type is NOT in the allow list", () => {
    const result = applyRecordTypeFilter("commit", ["pull_request", "issue"]);
    expect(result.filtered).toBe(true);
    expect(result.reason).toBe("record_type_not_allowed");
  });

  it("is case-sensitive", () => {
    const result = applyRecordTypeFilter("Pull_Request", ["pull_request"]);
    expect(result.filtered).toBe(true);
  });
});

// ── applyPathFilter ───────────────────────────────────────────────────────────

describe("applyPathFilter", () => {
  it("passes when patterns list is empty", () => {
    const result = applyPathFilter({ path: "node_modules/foo.ts" }, []);
    expect(result.filtered).toBe(false);
  });

  it("passes records without a path property", () => {
    const result = applyPathFilter({ title: "bug report" }, [
      "node_modules/**",
    ]);
    expect(result.filtered).toBe(false);
  });

  it("passes records with non-string path", () => {
    const result = applyPathFilter({ path: 42 }, ["node_modules/**"]);
    expect(result.filtered).toBe(false);
  });

  it("filters a path that matches a pattern", () => {
    const result = applyPathFilter({ path: "node_modules/react/index.js" }, [
      "node_modules/**",
    ]);
    expect(result.filtered).toBe(true);
    expect(result.reason).toBe("path_filtered");
  });

  it("does not filter a path that doesn't match any pattern", () => {
    const result = applyPathFilter({ path: "src/components/Button.tsx" }, [
      "node_modules/**",
      "dist/**",
    ]);
    expect(result.filtered).toBe(false);
  });

  it("filters .lock files using * pattern", () => {
    const result = applyPathFilter({ path: "yarn.lock" }, ["*.lock"]);
    expect(result.filtered).toBe(true);
  });

  it("filters .turbo paths", () => {
    const result = applyPathFilter({ path: ".turbo/cache/abc123" }, [
      ".turbo/**",
    ]);
    expect(result.filtered).toBe(true);
  });
});

// ── applyLabelFilter ──────────────────────────────────────────────────────────

describe("applyLabelFilter", () => {
  it("passes when patterns list is empty", () => {
    const result = applyLabelFilter({ labels: ["bug", "feature"] }, []);
    expect(result.filtered).toBe(false);
  });

  it("passes records without labels property", () => {
    const result = applyLabelFilter({ title: "foo" }, ["internal"]);
    expect(result.filtered).toBe(false);
  });

  it("passes records with empty labels array", () => {
    const result = applyLabelFilter({ labels: [] }, ["internal"]);
    expect(result.filtered).toBe(false);
  });

  it("filters when a label string matches a pattern", () => {
    const result = applyLabelFilter({ labels: ["bug", "internal"] }, [
      "internal",
    ]);
    expect(result.filtered).toBe(true);
    expect(result.reason).toBe("label_filtered");
  });

  it("filters when a label object's name matches a pattern", () => {
    const result = applyLabelFilter(
      { labels: [{ name: "feature" }, { name: "wip" }] },
      ["wip"],
    );
    expect(result.filtered).toBe(true);
    expect(result.reason).toBe("label_filtered");
  });

  it("does not filter when no labels match any pattern", () => {
    const result = applyLabelFilter({ labels: ["bug", "feature"] }, [
      "internal",
      "skip",
    ]);
    expect(result.filtered).toBe(false);
  });

  it("supports glob patterns for labels", () => {
    // Filter any label starting with "do-not-sync-"
    const result = applyLabelFilter(
      { labels: ["do-not-sync-prod", "feature"] },
      ["do-not-sync-*"],
    );
    expect(result.filtered).toBe(true);
  });

  it("handles mixed label formats in same array", () => {
    const result = applyLabelFilter(
      { labels: ["bug", { name: "skip" }, "feature"] },
      ["skip"],
    );
    expect(result.filtered).toBe(true);
  });

  it("ignores labels with non-string name fields", () => {
    const result = applyLabelFilter(
      { labels: [{ name: 42 }, { name: null }] },
      ["*"],
    );
    // Non-string names produce empty strings which are filtered out before matching
    expect(result.filtered).toBe(false);
  });
});

// ── shouldRunInference ────────────────────────────────────────────────────────

describe("shouldRunInference", () => {
  it("returns true when semanticInference is undefined (default enabled)", () => {
    expect(shouldRunInference("pull_request", undefined)).toBe(true);
  });

  it("returns false when semanticInference.enabled is false", () => {
    const cfg: DeliveryConfig["semanticInference"] = {
      enabled: false,
    };
    expect(shouldRunInference("pull_request", cfg)).toBe(false);
  });

  it("returns true when enabled and no perRecordType override", () => {
    const cfg: DeliveryConfig["semanticInference"] = {
      enabled: true,
    };
    expect(shouldRunInference("pull_request", cfg)).toBe(true);
  });

  it("returns false when perRecordType disables the record type", () => {
    const cfg: DeliveryConfig["semanticInference"] = {
      enabled: true,
      perRecordType: { commit: false, pull_request: true },
    };
    expect(shouldRunInference("commit", cfg)).toBe(false);
    expect(shouldRunInference("pull_request", cfg)).toBe(true);
  });

  it("returns true when perRecordType is set but does not mention the type", () => {
    const cfg: DeliveryConfig["semanticInference"] = {
      enabled: true,
      perRecordType: { commit: false },
    };
    // "issue" not mentioned → default to enabled
    expect(shouldRunInference("issue", cfg)).toBe(true);
  });

  it("global disabled takes priority over perRecordType enabled", () => {
    const cfg: DeliveryConfig["semanticInference"] = {
      enabled: false,
      perRecordType: { pull_request: true },
    };
    expect(shouldRunInference("pull_request", cfg)).toBe(false);
  });
});
