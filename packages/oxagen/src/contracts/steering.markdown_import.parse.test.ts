import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { RECORD_KINDS } from "../steering-repo/record-kind";
import { forcesFor } from "../steering-repo/record-force";
import { steeringMarkdownImportCommit } from "./steering.markdown_import.commit";
import { steeringMarkdownImportParse } from "./steering.markdown_import.parse";
import {
  markdownImportMemorySchema,
  markdownImportRecordSchema,
  type MarkdownImportMemory,
  type MarkdownImportRecord,
} from "./steering.markdown_import.shared";

function row(over: Partial<MarkdownImportRecord> = {}): MarkdownImportRecord {
  return {
    file: "CLAUDE.md",
    line: 3,
    origin: "split",
    lineage: "a-intel.claude.no-push-to-main",
    label: "No push to main",
    statement: "Never push to main.",
    kind: "constraint",
    kindReason: "It forbids an action.",
    force: "must",
    forceWords: "Never",
    effect: "forbid",
    tokens: 5,
    duplicate: null,
    conflict: null,
    action: "add",
    frontmatter: null,
    ...over,
  };
}

describe("the Markdown import contracts", () => {
  it("registers both under their verb-first names", () => {
    expect(getCapability("parse_markdown_import")).toBe(steeringMarkdownImportParse);
    expect(getCapability("commit_markdown_import")).toBe(steeringMarkdownImportCommit);
  });

  it("serves both on the api, mcp, agent, and cli surfaces, scoped and deny by default", () => {
    for (const cap of [steeringMarkdownImportParse, steeringMarkdownImportCommit]) {
      expect(cap.surfaces).toEqual(["api", "mcp", "agent", "cli"]);
      expect(cap.scoped).toBe(true);
      expect(cap.defaultEffect).toBe("deny");
      expect(cap.defaultRoles).toEqual({
        org: { Owner: "allow", Admin: "allow" },
        workspace: { Owner: "allow", Member: "allow" },
      });
      // The Steering page's Import Markdown dialog operates both (lane IMP2,
      // #4913), bound in apps/app/capability-ui-map.json.
      expect(cap.layers).toContain("app");
    }
  });

  it("makes parse read-only and billed, and commit a write that waits for approval on the agent surface", () => {
    expect(steeringMarkdownImportParse.mutates).toBe(false);
    expect("noBillingGate" in steeringMarkdownImportParse).toBe(false);
    expect(steeringMarkdownImportCommit.mutates).toBe(true);
    expect(steeringMarkdownImportCommit.noBillingGate).toBe(true);
    expect(steeringMarkdownImportCommit.agent?.requiresApproval).toBe(true);
  });

  it("takes 1 to 25 files of up to 100,000 characters", () => {
    const doc = { filename: "CLAUDE.md", content: "Never push to main." };
    expect(steeringMarkdownImportParse.input.safeParse({ documents: [doc] }).success).toBe(true);
    expect(steeringMarkdownImportParse.input.safeParse({ documents: [] }).success).toBe(false);
    expect(
      steeringMarkdownImportParse.input.safeParse({ documents: Array.from({ length: 26 }, () => doc) }).success,
    ).toBe(false);
    expect(
      steeringMarkdownImportParse.input.safeParse({ documents: [{ ...doc, content: "x".repeat(100_001) }] }).success,
    ).toBe(false);
  });

  it("takes the records, policies, memories, and skip targets, and no other (negative)", () => {
    const doc = { filename: "CLAUDE.md", content: "Never push to main." };
    for (const target of ["records", "policies", "memories", "skip"]) {
      expect(steeringMarkdownImportParse.input.safeParse({ documents: [{ ...doc, target }] }).success, target).toBe(
        true,
      );
    }
    expect(
      steeringMarkdownImportParse.input.safeParse({ documents: [{ ...doc, target: "decisions" }] }).success,
    ).toBe(false);
  });
});

function memoryRow(over: Partial<MarkdownImportMemory> = {}): MarkdownImportMemory {
  return {
    file: "notes.md",
    line: 2,
    label: "Staging resets nightly",
    statement: "The staging database resets every night.",
    kind: "memory",
    force: "info",
    duplicate: null,
    issue: null,
    action: "add",
    ...over,
  };
}

describe("markdownImportMemorySchema", () => {
  it("takes a memory with force info and refuses any other kind or force (negative)", () => {
    expect(markdownImportMemorySchema.safeParse(memoryRow()).success).toBe(true);
    expect(markdownImportMemorySchema.safeParse({ ...memoryRow(), kind: "fact" }).success).toBe(false);
    expect(markdownImportMemorySchema.safeParse({ ...memoryRow(), force: "should" }).success).toBe(false);
  });

  it("holds a row marked add to the 2,000 characters a memory takes (negative)", () => {
    const long = "x".repeat(2001);
    expect(markdownImportMemorySchema.safeParse(memoryRow({ statement: "x".repeat(2000) })).success).toBe(true);
    expect(markdownImportMemorySchema.safeParse(memoryRow({ statement: long })).success).toBe(false);
    expect(markdownImportMemorySchema.safeParse(memoryRow({ statement: long, action: "skip" })).success).toBe(true);
  });

  it("names a waiting memory, a rejected statement, or an earlier row as the match", () => {
    for (const duplicate of [
      { reason: "waiting", memory: "mem_01", file: null, line: null },
      { reason: "rejected", memory: null, file: null, line: null },
      { reason: "import", memory: null, file: "a.md", line: 3 },
    ] as const) {
      expect(markdownImportMemorySchema.safeParse(memoryRow({ duplicate, action: "skip" })).success).toBe(true);
    }
    expect(
      markdownImportMemorySchema.safeParse({
        ...memoryRow(),
        duplicate: { reason: "published", memory: null, file: null, line: null },
      }).success,
    ).toBe(false);
  });
});

describe("markdownImportRecordSchema", () => {
  it("accepts every force each kind allows, and refuses every other (negative)", () => {
    for (const kind of RECORD_KINDS) {
      for (const force of ["must", "should", "may", "info"] as const) {
        const effect = kind === "constraint" ? ("require" as const) : null;
        const ok = markdownImportRecordSchema.safeParse(row({ kind, force, effect })).success;
        expect(ok, `${kind} ${force}`).toBe(forcesFor(kind).includes(force));
      }
    }
  });

  it("requires an effect on a constraint and refuses one on every other kind (negative)", () => {
    expect(markdownImportRecordSchema.safeParse(row({ effect: null })).success).toBe(false);
    expect(
      markdownImportRecordSchema.safeParse(row({ kind: "code-rule", effect: "require" })).success,
    ).toBe(false);
    expect(markdownImportRecordSchema.safeParse(row({ kind: "code-rule", effect: null })).success).toBe(true);
  });

  it("ties frontmatter to a frontmatter record (negative)", () => {
    expect(markdownImportRecordSchema.safeParse(row({ origin: "frontmatter" })).success).toBe(false);
    expect(markdownImportRecordSchema.safeParse(row({ frontmatter: "schema: steering-record/v1" })).success).toBe(
      false,
    );
    expect(
      markdownImportRecordSchema.safeParse(row({ origin: "frontmatter", frontmatter: "schema: steering-record/v1" }))
        .success,
    ).toBe(true);
  });

  it("refuses a lineage and a label the steering record schema refuses (negative)", () => {
    expect(markdownImportRecordSchema.safeParse(row({ lineage: "Not A Lineage" })).success).toBe(false);
    expect(markdownImportRecordSchema.safeParse(row({ label: "x".repeat(37) })).success).toBe(false);
  });
});
