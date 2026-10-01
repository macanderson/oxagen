import { describe, expect, it } from "vitest";
import { markMatches, type MatchedRow, type PublishedRecord } from "./matches";

function row(lineage: string, statement: string, over: Partial<MatchedRow> = {}): MatchedRow {
  return {
    lineage,
    kind: "business-rule",
    effect: null,
    statement,
    path: `steering/business-rules/${lineage}.md`,
    duplicate: null,
    conflict: null,
    ...over,
  };
}

function published(
  lineage: string,
  statement: string,
  over: Partial<PublishedRecord> = {},
): PublishedRecord {
  return {
    lineage,
    kind: "business-rule",
    effect: null,
    statement,
    path: `steering/platform/${lineage}.md`,
    ...over,
  };
}

describe("markMatches", () => {
  it("names the published record a row says again", () => {
    const rows = [row("a-intel.claude.no-push", "Never push to main.")];
    markMatches(rows, [published("a-intel.platform.no-push-to-main", "never push to MAIN")]);
    expect(rows[0]?.duplicate).toEqual({
      lineage: "a-intel.platform.no-push-to-main",
      path: "steering/platform/a-intel.platform.no-push-to-main.md",
      published: true,
    });
    expect(rows[0]?.conflict).toBeNull();
  });

  it("marks a constraint with the opposite effect of a published one as a conflict", () => {
    const rows = [
      row("a-intel.claude.friday", "Deploy on Fridays", { kind: "constraint", effect: "require" }),
    ];
    markMatches(rows, [
      published("a-intel.platform.friday", "Deploy on Fridays", { kind: "constraint", effect: "forbid" }),
    ]);
    expect(rows[0]?.conflict?.lineage).toBe("a-intel.platform.friday");
    expect(rows[0]?.duplicate).toBeNull();
  });

  it("marks the later of two rows that say the same thing, naming the earlier", () => {
    const rows = [
      row("a-intel.claude.no-push", "Never push to main."),
      row("a-intel.agents.no-push", "Never push to main."),
    ];
    markMatches(rows, []);
    expect(rows[0]?.duplicate).toBeNull();
    expect(rows[1]?.duplicate).toEqual({
      lineage: "a-intel.claude.no-push",
      path: "steering/business-rules/a-intel.claude.no-push.md",
      published: false,
    });
  });

  it("leaves rows that say different things alone (negative)", () => {
    const rows = [row("a", "Use tabs for indentation"), row("b", "Use spaces for indentation")];
    markMatches(rows, [published("c", "Tag every release")]);
    expect(rows.map((r) => [r.duplicate, r.conflict])).toEqual([
      [null, null],
      [null, null],
    ]);
  });

  it("marks a revision that says what its published version says as a duplicate of it", () => {
    const rows = [row("a-intel.platform.no-push-to-main", "Never push to main.")];
    markMatches(rows, [published("a-intel.platform.no-push-to-main", "Never push to main.")]);
    expect(rows[0]?.duplicate?.lineage).toBe("a-intel.platform.no-push-to-main");
  });

  it("lets a revision change its own published statement without a mark", () => {
    const rows = [row("a-intel.platform.no-push-to-main", "Open a pull request for every change.")];
    markMatches(rows, [published("a-intel.platform.no-push-to-main", "Never push to main.")]);
    expect(rows[0]?.duplicate).toBeNull();
    expect(rows[0]?.conflict).toBeNull();
  });

  it("marks a revision that turns a published constraint's effect around as a conflict", () => {
    const rows = [
      row("a-intel.platform.friday", "Deploy on Fridays", { kind: "constraint", effect: "require" }),
    ];
    markMatches(rows, [
      published("a-intel.platform.friday", "Deploy on Fridays", { kind: "constraint", effect: "forbid" }),
    ]);
    expect(rows[0]?.conflict?.lineage).toBe("a-intel.platform.friday");
  });
});
