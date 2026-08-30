import { describe, it, expect } from "vitest";
import {
  renderRulesSection,
  guardDenyEntry,
  guardsToDeny,
} from "../enforce.js";
import { evaluateLocalPermission } from "../../settings/permissions-gate.js";
import type { Rule } from "../types.js";

const rule = (over: Partial<Rule> & { id: string }): Rule => ({
  description: "",
  text: "do the thing",
  source: "test",
  ...over,
});

describe("renderRulesSection", () => {
  it("returns empty string with no rules", () => {
    expect(renderRulesSection([])).toBe("");
  });
  it("lists rules and marks enforced ones", () => {
    const out = renderRulesSection([
      rule({ id: "a", text: "Always read before editing." }),
      rule({
        id: "b",
        text: "Never edit applied migrations.",
        guard: { tool: "Edit", denyPathGlob: "m/**" },
      }),
    ]);
    expect(out).toContain("Workspace rules");
    expect(out).toContain("Always read before editing.");
    expect(out).toContain("Never edit applied migrations.  [enforced]");
  });
});

describe("guardDenyEntry", () => {
  it("builds Tool(glob) for a path guard", () => {
    expect(
      guardDenyEntry(
        rule({ id: "x", guard: { tool: "Edit", denyPathGlob: "m/**" } }),
      ),
    ).toBe("Edit(m/**)");
  });
  it("builds Tool(glob) for a command guard", () => {
    expect(
      guardDenyEntry(
        rule({ id: "x", guard: { tool: "Bash", denyCommandGlob: "rm -rf*" } }),
      ),
    ).toBe("Bash(rm -rf*)");
  });
  it("builds a bare tool when no pattern", () => {
    expect(guardDenyEntry(rule({ id: "x", guard: { tool: "Bash" } }))).toBe(
      "Bash",
    );
  });
  it("returns null without a guard", () => {
    expect(guardDenyEntry(rule({ id: "x" }))).toBeNull();
  });
});

describe("guardsToDeny", () => {
  it("produces deny entries + a reason map keyed by entry", () => {
    const { deny, reasons } = guardsToDeny([
      rule({
        id: "no-mig",
        text: "Add a forward migration.",
        guard: { tool: "Edit", denyPathGlob: "mig/*-applied/**" },
      }),
      rule({ id: "style", text: "prompt only" }), // no guard → no deny
    ]);
    expect(deny).toEqual(["Edit(mig/*-applied/**)"]);
    expect(reasons["Edit(mig/*-applied/**)"]).toContain('rule "no-mig"');
    expect(reasons["Edit(mig/*-applied/**)"]).toContain(
      "Add a forward migration.",
    );
  });

  it("the produced deny entries actually block via the permission gate", () => {
    const { deny } = guardsToDeny([
      rule({
        id: "no-mig",
        guard: {
          tool: "Edit",
          denyPathGlob: "packages/database/migrations/*-applied/**",
        },
      }),
    ]);
    const blocked = evaluateLocalPermission(
      "edit_file",
      { path: "packages/database/migrations/0001-applied/up.sql" },
      { deny },
    );
    expect(blocked.decision).toBe("deny");
    const allowed = evaluateLocalPermission(
      "edit_file",
      { path: "src/app.ts" },
      { deny },
    );
    expect(allowed.decision).toBe("allow");
  });
});
