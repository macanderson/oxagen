import { describe, expect, it } from "vitest";
import {
  CHECK_NAMES,
  checkResultSchema,
  constraintEffectSchema,
  proposalStatusSchema,
  proposedRecordSchema,
} from "./context.steering.shared";

const base = {
  lineageId: "ctx.release.no-reread-changelog",
  kind: "rule",
  force: "should",
  sharingScope: "workspace",
  statement: "Do not re-read CHANGELOG.md more than once in a run.",
};

describe("steering vocabulary", () => {
  it("cannot express an allow constraint: a record never grants authority", () => {
    expect(constraintEffectSchema.safeParse("allow").success).toBe(false);
    expect(constraintEffectSchema.options).toEqual(["require", "forbid"]);
  });

  it("requires an effect on a constraint and refuses one on every other kind", () => {
    expect(
      proposedRecordSchema.safeParse({ ...base, kind: "constraint" }).success,
    ).toBe(false);
    expect(
      proposedRecordSchema.safeParse({
        ...base,
        kind: "constraint",
        constraintEffect: "forbid",
      }).success,
    ).toBe(true);
    const r = proposedRecordSchema.safeParse({
      ...base,
      constraintEffect: "forbid",
    });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues[0]?.path).toEqual(["constraintEffect"]);
  });

  it("a lineage id is a file stem: lowercase, dots and hyphens, no slashes", () => {
    expect(
      proposedRecordSchema.safeParse({ ...base, lineageId: "../rules/x" })
        .success,
    ).toBe(false);
    expect(
      proposedRecordSchema.safeParse({ ...base, lineageId: "Ctx.Upper" })
        .success,
    ).toBe(false);
  });

  it("trims a title and refuses a blank one", () => {
    expect(
      proposedRecordSchema.safeParse({ ...base, title: "   " }).success,
    ).toBe(false);
    const r = proposedRecordSchema.safeParse({ ...base, title: "  Reads  " });
    expect(r.success && r.data.title).toBe("Reads");
  });

  it("caps a label at 36 characters (ADR-178)", () => {
    const ok = proposedRecordSchema.safeParse({
      ...base,
      label: "x".repeat(36),
    });
    expect(ok.success).toBe(true);
    expect(
      proposedRecordSchema.safeParse({ ...base, label: "x".repeat(37) })
        .success,
    ).toBe(false);
    expect(
      proposedRecordSchema.safeParse({ ...base, label: "  " }).success,
    ).toBe(false);
  });

  it("runs the six §10.3 checks in order and records each outcome", () => {
    expect(CHECK_NAMES).toEqual([
      "schema",
      "lineage_uniqueness",
      "record_hash",
      "secret_pii_scan",
      "conflict_against_active",
      "constraint_effect",
    ]);
    expect(
      checkResultSchema.safeParse({
        name: "schema",
        status: "passed",
        summary: "context-record/v0.1 valid",
        detailsUrl: null,
        startedAt: "2026-09-15T00:00:00.000Z",
        completedAt: "2026-09-15T00:00:01.000Z",
      }).success,
    ).toBe(true);
  });

  it("names every state of the Context PR state machine and no candidate state", () => {
    expect(proposalStatusSchema.options).toEqual([
      "proposed",
      "pr_open",
      "checks_running",
      "checks_passed",
      "checks_failed",
      "merged",
      "rejected",
    ]);
  });
});
