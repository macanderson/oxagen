import { describe, expect, it } from "vitest";
import { PAGE_FAILURES, PAGE_KEYS, isPageKey } from "./page-states";

describe("page failures (plan §2.1)", () => {
  it.each([
    ["fleet", "run_index_unavailable", 503],
    ["run", "frame_store_unreachable", 502],
    ["agents", "iam_principals_unavailable", 503],
    ["mandate", "mandate_ledger_unavailable", 503],
    ["tools", "tool_registry_unavailable", 503],
    ["ontology", "graph_read_timeout", 504],
    ["steering", "record_index_unavailable", 503],
    ["spend", "rollup_rebuild_in_progress", 504],
    ["organization", "control_plane_unavailable", 503],
    ["billing", "stripe_unreachable", 502],
    ["audit", "audit_store_unavailable", 503],
  ] as const)("%s fails with %s (%i)", (page, code, status) => {
    expect(PAGE_FAILURES[page].error).toEqual({ code, status });
  });

  it("names a denied permission for every page", () => {
    for (const page of PAGE_KEYS)
      expect(PAGE_FAILURES[page].permission).toMatch(/^[a-z]+\.[a-z]+$/);
  });

  it("recognises page keys and rejects anything else (negative)", () => {
    expect(isPageKey("fleet")).toBe(true);
    expect(isPageKey("dashboard")).toBe(false);
    expect(isPageKey("")).toBe(false);
  });
});
