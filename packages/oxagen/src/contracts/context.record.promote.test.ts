import { describe, expect, it } from "vitest";
import { contextRecordPromote } from "./context.record.promote";
import { getCapability } from "../registry";

describe("context.record.promote capability", () => {
  it("registers under its verb-first name", () => {
    expect(getCapability("promote_context_record")).toBe(contextRecordPromote);
  });

  it("is an api-only, high-sensitivity, default-deny governance write", () => {
    expect(contextRecordPromote.surfaces).toEqual(["api"]);
    expect(contextRecordPromote.sensitivity).toBe("high");
    expect(contextRecordPromote.defaultEffect).toBe("deny");
  });

  // ── input ─────────────────────────────────────────────────────────────────

  it("accepts a promote naming a version", () => {
    const parsed = contextRecordPromote.input.parse({
      record_id: "ctr_abc",
      action: "promote",
      version_id: "crv_def",
      policy_version: "regulated-1",
    });
    expect(parsed.action).toBe("promote");
  });

  it("accepts a retire without a version", () => {
    const parsed = contextRecordPromote.input.parse({
      record_id: "no-bare-unwrap",
      action: "retire",
      policy_version: "regulated-1",
    });
    expect(parsed.version_id).toBeUndefined();
  });

  it("rejects an unknown action", () => {
    expect(() =>
      contextRecordPromote.input.parse({
        record_id: "ctr_abc",
        action: "archive",
        policy_version: "regulated-1",
      }),
    ).toThrow();
  });

  it("rejects a missing policy_version", () => {
    expect(() =>
      contextRecordPromote.input.parse({
        record_id: "ctr_abc",
        action: "promote",
        version_id: "crv_def",
      }),
    ).toThrow();
  });

  // ── output ────────────────────────────────────────────────────────────────

  it("parses a valid output", () => {
    const parsed = contextRecordPromote.output.parse({
      recordId: "ctr_abc",
      action: "promote",
      seq: 1,
      chainDigest: "a".repeat(64),
      status: "active",
    });
    expect(parsed.seq).toBe(1);
  });

  it("rejects a non-positive seq", () => {
    expect(() =>
      contextRecordPromote.output.parse({
        recordId: "ctr_abc",
        action: "retire",
        seq: 0,
        chainDigest: "a".repeat(64),
        status: "retired",
      }),
    ).toThrow();
  });
});
