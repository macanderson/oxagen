import { describe, expect, it } from "vitest";
import { PAGE_ERRORS, PAGE_KEYS, isPageKey } from "./page-errors";

describe("PAGE_ERRORS", () => {
  it("covers every page key and nothing else", () => {
    expect(Object.keys(PAGE_ERRORS).sort()).toEqual([...PAGE_KEYS].sort());
  });

  it.each(PAGE_KEYS)(
    "%s has a snake_case code, a 5xx status and a permission",
    (page) => {
      const spec = PAGE_ERRORS[page];
      expect(spec.code).toMatch(/^[a-z]+(_[a-z]+)+$/);
      expect(spec.status).toBeGreaterThanOrEqual(500);
      expect(spec.status).toBeLessThan(600);
      expect(spec.permission).toMatch(/^[a-z]+\.[a-z]+$/);
    },
  );

  // Plan §2.1: the named error for each of the pages the spec lists.
  it.each([
    ["fleet", 503, "run_index_unavailable"],
    ["run", 502, "frame_store_unreachable"],
    ["agents", 503, "iam_principals_unavailable"],
    ["mandate", 503, "mandate_ledger_unavailable"],
    ["tools", 503, "tool_registry_unavailable"],
    ["ontology", 504, "graph_read_timeout"],
    ["steering", 503, "record_index_unavailable"],
    ["spend", 504, "rollup_rebuild_in_progress"],
    ["organization", 503, "control_plane_unavailable"],
    ["billing", 502, "stripe_unreachable"],
    ["audit", 503, "audit_store_unavailable"],
  ] as const)("%s reports %i %s", (page, status, code) => {
    expect(PAGE_ERRORS[page]).toMatchObject({ status, code });
  });
});

describe("isPageKey", () => {
  it("accepts a known page and refuses anything else", () => {
    expect(isPageKey("fleet")).toBe(true);
    expect(isPageKey("sessions")).toBe(false);
    expect(isPageKey("")).toBe(false);
  });
});
