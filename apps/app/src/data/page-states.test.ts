import { describe, expect, it } from "vitest";
import { PAGE_FAILURES, PAGE_KEYS, isPageKey } from "./page-states";

describe("page failures (plan §2.1)", () => {
  it("covers every page key and nothing else", () => {
    expect(Object.keys(PAGE_FAILURES).sort()).toEqual([...PAGE_KEYS].sort());
  });

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

  it.each(PAGE_KEYS)(
    "%s has a snake_case code, a 5xx status and a permission",
    (page) => {
      const { error, permission } = PAGE_FAILURES[page];
      expect(error.code).toMatch(/^[a-z]+(_[a-z]+)+$/);
      expect(error.status).toBeGreaterThanOrEqual(500);
      expect(error.status).toBeLessThan(600);
      expect(permission).toMatch(/^[a-z]+\.[a-z]+$/);
    },
  );

  it("names the onboarding permissions the gate and Register deny on", () => {
    expect(PAGE_FAILURES.welcome.permission).toBe("org.create");
    expect(PAGE_FAILURES.register.permission).toBe("agent.register");
  });

  it("recognises page keys and rejects anything else (negative)", () => {
    expect(isPageKey("fleet")).toBe(true);
    expect(isPageKey("welcome")).toBe(true);
    expect(isPageKey("dashboard")).toBe(false);
    expect(isPageKey("sessions")).toBe(false);
    expect(isPageKey("")).toBe(false);
  });
});
