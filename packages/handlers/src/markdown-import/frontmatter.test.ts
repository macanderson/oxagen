import { describe, expect, it } from "vitest";
import { readFrontmatterRecord } from "./frontmatter";

const RECORD = [
  "---",
  "schema: steering-record/v1",
  "lineage: a-intel.platform.release-steps",
  "label: Release steps",
  "kind: procedure",
  "force: should",
  "scope: workspace",
  "status: active",
  "origin: user",
  "provenance:",
  "  source: proposal",
  "  uri: oxagen:proposal/prp_01",
  "---",
  "",
  "1. Tag the release.",
  "2. Publish the notes.",
  "",
].join("\n");

describe("readFrontmatterRecord", () => {
  it("reads a file with steering-record/v1 frontmatter as one record", () => {
    const read = readFrontmatterRecord(RECORD);
    expect(read.kind).toBe("record");
    if (read.kind !== "record") return;
    expect(read.record).toMatchObject({ lineage: "a-intel.platform.release-steps", kind: "procedure" });
    expect(read.statement).toBe("1. Tag the release.\n2. Publish the notes.");
    expect(read.bodyLine).toBe(15);
    expect(read.frontmatter.startsWith("schema: steering-record/v1\n")).toBe(true);
  });

  it("leaves a file with no frontmatter, or other frontmatter, to the split", () => {
    expect(readFrontmatterRecord("Never push to main.").kind).toBe("none");
    expect(readFrontmatterRecord("---\ndescription: Cursor rule\nglobs: '*.ts'\n---\nUse tabs.").kind).toBe(
      "none",
    );
  });

  it("names what is wrong with steering-record/v1 frontmatter that does not read (negative)", () => {
    const read = readFrontmatterRecord(RECORD.replace("kind: procedure", "kind: decision"));
    expect(read.kind).toBe("invalid");
    if (read.kind !== "invalid") return;
    expect(read.message).toContain("does not read as a record");
  });
});
