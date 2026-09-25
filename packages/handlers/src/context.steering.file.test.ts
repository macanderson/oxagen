import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRecordFile,
  contextBranch,
  lineageSlug,
  parseRecordFile,
  readRecordFile,
  recordFilePath,
  reviseRecordStatement,
  serializeRecordFile,
  stampRecordObject,
} from "./context.steering.file";

// A record Stella stamped itself (macanderson/stella, .stella/rules/), copied
// verbatim: its record_id and record_hash are the values Stella's loader
// accepts, so recomputing them here proves the two sides hash the same bytes.
const STELLA_FILE = readFileSync(
  join(__dirname, "fixtures/steering/stella-stamped-record.toml"),
  "utf8",
);

describe("record file", () => {
  it("recomputes the record_id and record_hash Stella stamped on its own file", () => {
    const tree = parseRecordFile(STELLA_FILE) as {
      record: Record<string, unknown>[];
    };
    const record = tree.record[0]!;
    expect(record.record_id).toBe(
      "rec_macanderson_stella_search_before_filing_issue_4d4aa206f0bb",
    );
    expect(stampRecordObject(record)).toEqual({
      record_id: record.record_id,
      record_hash: record.record_hash,
    });
  });

  it("derives the file stem, the branch and Stella's slug from the lineage", () => {
    expect(recordFilePath("ctx.release.no-reread-changelog")).toBe(
      ".oxagen/rules/ctx.release.no-reread-changelog.toml",
    );
    expect(contextBranch("ctx.release.no-reread-changelog")).toBe(
      "context/ctx.release.no-reread-changelog",
    );
    expect(lineageSlug("ctx.release.no-reread-changelog")).toBe(
      "release_no_reread_changelog",
    );
  });

  it("writes one stamped record in Stella's layout and reads it back unchanged", () => {
    const file = buildRecordFile({
      lineageId: "ctx.release.no-reread-changelog",
      kind: "rule",
      force: "should",
      sharingScope: "workspace",
      statement: 'Do not re-read "CHANGELOG.md" more than once in a run.',
      origin: "user",
      proposalPublicId: "prp_1",
      setId: "a-intel.platform",
    });
    const text = serializeRecordFile(file);
    expect(text).toContain('schema = "context-record/v0.1"');
    expect(text).toContain("[[record]]");
    expect(text).toContain("[record.provenance]");
    expect(text).toContain('force = "should"');
    const back = parseRecordFile(text) as typeof file;
    expect(back).toEqual(file);
    const record = file.record[0]!;
    expect(record.record_id).toMatch(
      /^rec_release_no_reread_changelog_[0-9a-f]{12}$/,
    );
    expect(
      stampRecordObject(back.record[0] as unknown as Record<string, unknown>),
    ).toEqual({
      record_id: record.record_id,
      record_hash: record.record_hash,
    });
  });

  it("changes the identity when the statement changes and keeps it when the hash field is edited", () => {
    const a = buildRecordFile({
      lineageId: "ctx.a",
      kind: "fact",
      force: "info",
      sharingScope: "repository",
      statement: "one",
      origin: "inferred",
      proposalPublicId: "prp_1",
      setId: "o.r",
    }).record[0]!;
    const b = { ...a, statement: "two" };
    expect(stampRecordObject(b).record_hash).not.toBe(a.record_hash);
    expect(stampRecordObject({ ...a, record_hash: "sha256:tampered" })).toEqual(
      {
        record_id: a.record_id,
        record_hash: a.record_hash,
      },
    );
  });

  it("writes the label after the lineage and keeps it out of the hash (ADR-178)", () => {
    const input = {
      lineageId: "ctx.release.no-reread-changelog",
      kind: "rule" as const,
      force: "should" as const,
      sharingScope: "workspace" as const,
      statement: "Do not re-read CHANGELOG.md more than once in a run.",
      origin: "user" as const,
      proposalPublicId: "prp_1",
      setId: "a-intel.platform",
    };
    const unnamed = buildRecordFile(input).record[0]!;
    const named = buildRecordFile({
      ...input,
      label: "Read the changelog once",
    }).record[0]!;
    const renamed = buildRecordFile({ ...input, label: "Changelog once" })
      .record[0]!;
    // A name is not content: the three share one identity.
    expect(named.record_hash).toBe(unnamed.record_hash);
    expect(named.record_id).toBe(unnamed.record_id);
    expect(renamed.record_hash).toBe(unnamed.record_hash);
    expect(Object.keys(named).slice(0, 3)).toEqual([
      "lineage_id",
      "label",
      "record_id",
    ]);
    expect("label" in unnamed).toBe(false);

    const text = serializeRecordFile(
      buildRecordFile({ ...input, label: "Read the changelog once" }),
    );
    expect(text).toContain('label = "Read the changelog once"');
    expect(readRecordFile(text)?.label).toBe("Read the changelog once");
    expect(
      readRecordFile(serializeRecordFile(buildRecordFile(input)))?.label,
    ).toBeNull();
  });

  it("carries the label through a statement revision", () => {
    const text = serializeRecordFile(
      buildRecordFile({
        lineageId: "ctx.a",
        label: "Cache the first read",
        kind: "fact",
        force: "info",
        sharingScope: "repository",
        statement: "one",
        origin: "inferred",
        proposalPublicId: "prp_1",
        setId: "o.r",
      }),
    );
    const revised = reviseRecordStatement(text, "two")!;
    const back = readRecordFile(revised)!;
    expect(back.label).toBe("Cache the first read");
    expect(back.statement).toBe("two");
    const raw = (
      parseRecordFile(revised) as { record: Record<string, unknown>[] }
    ).record[0]!;
    expect(stampRecordObject(raw)).toEqual({
      record_id: back.recordId,
      record_hash: back.recordHash,
    });
  });
});
