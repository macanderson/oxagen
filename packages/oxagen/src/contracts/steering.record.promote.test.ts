import { describe, expect, it } from "vitest";
import { steeringRecordPromote } from "./steering.record.promote";
import { getCapability } from "../registry";

describe("steering.record.promote capability", () => {
  it("registers under its verb-first name", () => {
    expect(getCapability("promote_steering_record")).toBe(steeringRecordPromote);
  });

  it("is an api-only, high-sensitivity, default-deny governance write", () => {
    expect(steeringRecordPromote.surfaces).toEqual(["api"]);
    expect(steeringRecordPromote.sensitivity).toBe("high");
    expect(steeringRecordPromote.defaultEffect).toBe("deny");
  });

  // ── input ─────────────────────────────────────────────────────────────────

  it("accepts a promote naming a version", () => {
    const parsed = steeringRecordPromote.input.parse({
      record_id: "ctr_abc",
      action: "promote",
      version_id: "crv_def",
      policy_version: "regulated-1",
    });
    expect(parsed.action).toBe("promote");
  });

  it("accepts a retire without a version", () => {
    const parsed = steeringRecordPromote.input.parse({
      record_id: "no-bare-unwrap",
      action: "retire",
      policy_version: "regulated-1",
    });
    expect(parsed.version_id).toBeUndefined();
  });

  it("rejects an unknown action", () => {
    expect(() =>
      steeringRecordPromote.input.parse({
        record_id: "ctr_abc",
        action: "archive",
        policy_version: "regulated-1",
      }),
    ).toThrow();
  });

  it("rejects a missing policy_version", () => {
    expect(() =>
      steeringRecordPromote.input.parse({
        record_id: "ctr_abc",
        action: "promote",
        version_id: "crv_def",
      }),
    ).toThrow();
  });

  // ── output ────────────────────────────────────────────────────────────────

  it("parses a valid output", () => {
    const parsed = steeringRecordPromote.output.parse({
      recordId: "ctr_abc",
      action: "promote",
      seq: 1,
      chainDigest: "a".repeat(64),
      status: "active",
      validUntil: null,
    });
    expect(parsed.seq).toBe(1);
  });

  it("rejects a non-positive seq", () => {
    expect(() =>
      steeringRecordPromote.output.parse({
        recordId: "ctr_abc",
        action: "retire",
        seq: 0,
        chainDigest: "a".repeat(64),
        status: "retired",
      }),
    ).toThrow();
  });
});
