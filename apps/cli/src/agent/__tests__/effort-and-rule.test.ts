/**
 * Unit coverage for the reasoning-effort resolver and the permission-rule
 * describer added for CLI observability:
 *   - resolveEffort / isReasoningEffort / EFFORT_LEVELS (agent/model.ts)
 *   - persistedRuleString (agent/permissions.ts) — the exact settings.json rule
 *     string the broker writes when the user chooses "allow + remember".
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  isReasoningEffort,
  resolveEffort,
  EFFORT_LEVELS,
} from "../model.js";
import { persistedRuleString } from "../permissions.js";
import type { PermissionRequest } from "../permissions.js";

describe("reasoning effort", () => {
  afterEach(() => {
    delete process.env["OXAGEN_EFFORT"];
  });

  it("EFFORT_LEVELS includes the deep Anthropic tiers", () => {
    expect(EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("isReasoningEffort accepts every level and rejects others", () => {
    for (const level of EFFORT_LEVELS) expect(isReasoningEffort(level)).toBe(true);
    expect(isReasoningEffort("ultra")).toBe(false);
    expect(isReasoningEffort("")).toBe(false);
    expect(isReasoningEffort("HIGH")).toBe(false);
  });

  it("resolveEffort honors an explicit override, including xhigh/max", () => {
    expect(resolveEffort("high")).toBe("high");
    expect(resolveEffort("xhigh")).toBe("xhigh");
    expect(resolveEffort("max")).toBe("max");
  });

  it("resolveEffort ignores an invalid override and falls through", () => {
    expect(resolveEffort("bogus")).toBeUndefined();
  });

  it("resolveEffort reads OXAGEN_EFFORT when no override is given", () => {
    process.env["OXAGEN_EFFORT"] = "xhigh";
    expect(resolveEffort()).toBe("xhigh");
    process.env["OXAGEN_EFFORT"] = "nonsense";
    expect(resolveEffort()).toBeUndefined();
  });
});

describe("persistedRuleString", () => {
  const cwd = "/repo";

  it("formats a bash command rule verbatim", () => {
    const req: PermissionRequest = { tool: "bash", command: "pnpm build", cwd };
    expect(persistedRuleString(req, "allow", cwd)).toBe("Bash(pnpm build)");
  });

  it("formats a write rule with a workspace-relative path", () => {
    const req: PermissionRequest = { tool: "write_file", path: "/repo/src/a.ts", cwd };
    expect(persistedRuleString(req, "allow", cwd)).toBe("Write(src/a.ts)");
  });

  it("formats an edit rule and carries the decision through", () => {
    const req: PermissionRequest = { tool: "edit_file", path: "/repo/pkg/x.ts", cwd };
    expect(persistedRuleString(req, "deny", cwd)).toBe("Edit(pkg/x.ts)");
  });
});
