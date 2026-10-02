import { describe, expect, it } from "vitest";
import type { MarkdownImportRecord } from "@oxagen/oxagen/contracts/steering.markdown_import.shared";
import { readSteeringRecord } from "@oxagen/oxagen/steering-repo/record";
import { isHandlerError } from "@oxagen/oxagen";
import { importRecordPath, importUri, renderImportRecord } from "./render";

function row(over: Partial<MarkdownImportRecord> = {}): MarkdownImportRecord {
  return {
    file: "CLAUDE.md",
    line: 3,
    origin: "split",
    lineage: "a-intel.claude.no-push-to-main",
    label: "No push to main",
    statement: "Never push to main. Open a pull request instead.",
    kind: "constraint",
    kindReason: "It forbids an action.",
    force: "must",
    forceWords: "Never",
    effect: "forbid",
    tokens: 12,
    duplicate: null,
    conflict: null,
    action: "add",
    frontmatter: null,
    ...over,
  };
}

describe("importRecordPath", () => {
  it("puts each kind in its folder", () => {
    expect(importRecordPath("business-rule", "a.b")).toBe("steering/business-rules/a.b.md");
    expect(importRecordPath("code-rule", "a.b")).toBe("steering/code-rules/a.b.md");
    expect(importRecordPath("constraint", "a.b")).toBe("steering/constraints/a.b.md");
    expect(importRecordPath("procedure", "a.b")).toBe("steering/procedures/a.b.md");
    expect(importRecordPath("fact", "a.b")).toBe("steering/facts/a.b.md");
    expect(importRecordPath("preference", "a.b")).toBe("steering/preferences/a.b.md");
    expect(importRecordPath("skill", "a.b")).toBe("steering/skills/a.b/SKILL.md");
    expect(importRecordPath("memory", "a.b")).toBe("steering/memory/workspace/general/a.b.md");
  });

  it("writes a revision where its published record lives", () => {
    expect(importRecordPath("fact", "a.b", "steering/platform/a.b.md")).toBe("steering/platform/a.b.md");
    expect(importRecordPath("skill", "a.b", "steering/skills/a.b/SKILL.md")).toBe(
      "steering/skills/a.b/SKILL.md",
    );
  });

  it("never reuses a path that holds no steering record of the same shape (negative)", () => {
    expect(importRecordPath("fact", "a.b", ".oxagen/rules/a.b.toml")).toBe("steering/facts/a.b.md");
    expect(importRecordPath("fact", "a.b", "steering/skills/a.b/SKILL.md")).toBe("steering/facts/a.b.md");
    expect(importRecordPath("skill", "a.b", "steering/platform/a.b.md")).toBe("steering/skills/a.b/SKILL.md");
  });
});

describe("importUri", () => {
  it("names the file and line, encoding each path segment", () => {
    expect(importUri("docs/Release notes.md", 12)).toBe("oxagen:import/docs/Release%20notes.md#L12");
  });
});

describe("renderImportRecord", () => {
  it("writes a split statement as a steering record with origin user and provenance import", () => {
    const text = renderImportRecord(row());
    const read = readSteeringRecord(text);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.record).toMatchObject({
      schema: "steering-record/v1",
      lineage: "a-intel.claude.no-push-to-main",
      label: "No push to main",
      description: "Never push to main.",
      kind: "constraint",
      effect: "forbid",
      force: "must",
      scope: "workspace",
      status: "active",
      origin: "user",
      provenance: { source: "import", uri: "oxagen:import/CLAUDE.md#L3" },
    });
    expect(read.record.id).toBeUndefined();
    expect(text.endsWith("\n\nNever push to main. Open a pull request instead.\n")).toBe(true);
  });

  it("gives a skill a name and a description", () => {
    const text = renderImportRecord(
      row({ kind: "skill", effect: null, force: "may", lineage: "a-intel.claude.release-steps" }),
    );
    const read = readSteeringRecord(text);
    expect(read.ok && read.record).toMatchObject({ kind: "skill", name: "release-steps" });
  });

  it("keeps a frontmatter record's fields, sets the row's, and drops its id and hash", () => {
    const frontmatter = [
      "schema: steering-record/v1",
      "lineage: a-intel.platform.tenant-queries",
      "label: Tenant queries",
      "kind: code-rule",
      "force: must",
      "scope: workspace",
      "applies_to:",
      '  - "packages/**/*.ts"',
      "status: active",
      "origin: user",
      "provenance:",
      "  source: proposal",
      "  uri: oxagen:proposal/prp_01",
      "id: rec_a_intel_platform_tenant_queries_000000000000",
      "hash: sha256:0000000000000000000000000000000000000000000000000000000000000000",
    ].join("\n");
    const text = renderImportRecord(
      row({
        origin: "frontmatter",
        frontmatter,
        lineage: "a-intel.platform.tenant-queries",
        label: "Tenant queries",
        kind: "code-rule",
        force: "should",
        effect: null,
        statement: "Scope every query by tenant.",
      }),
    );
    const read = readSteeringRecord(text);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.record).toMatchObject({
      kind: "code-rule",
      force: "should",
      applies_to: ["packages/**/*.ts"],
      provenance: { source: "proposal" },
    });
    expect(text).not.toContain("id: rec_");
    expect(text).not.toContain("hash: sha256");
  });

  it("refuses a row that does not make a steering record (negative)", () => {
    let caught: unknown;
    try {
      renderImportRecord(row({ label: "x".repeat(40) }));
    } catch (err) {
      caught = err;
    }
    expect(isHandlerError(caught) && caught.reason).toBe("record_unreadable");
  });
});
