import { describe, expect, it } from "vitest";
import { steeringRecordsAppend } from "./steering.records.append";

const base = {
  kind: "observation",
  lineageId: "ctx.platform.safari-e2e-flake",
  statement: "The checkout suite flaked on Safari through August.",
};

describe("append_record contract", () => {
  it("is the agent's append: on the agent surface, unmetered, no approval, a write", () => {
    expect(steeringRecordsAppend.name).toBe("append_record");
    expect(steeringRecordsAppend.surfaces).toContain("agent");
    expect(steeringRecordsAppend.mutates).toBe(true);
    expect(steeringRecordsAppend.noBillingGate).toBe(true);
    expect(steeringRecordsAppend.agent?.requiresApproval).toBe(false);
  });

  it("accepts the seven §9 kinds and lets a directive through to the handler's refusal", () => {
    for (const kind of [
      "observation",
      "memory",
      "knowledge",
      "evidence",
      "record_proposal",
      "context_use",
      "context_use_feedback",
      "directive",
    ]) {
      expect(
        steeringRecordsAppend.input.safeParse({ ...base, kind }).success,
      ).toBe(true);
    }
    expect(
      steeringRecordsAppend.input.safeParse({ ...base, kind: "rule" }).success,
    ).toBe(false);
  });

  it("defaults the scope to the workspace and the refs to empty", () => {
    expect(steeringRecordsAppend.input.parse(base)).toEqual({
      ...base,
      sharingScope: "workspace",
      sourceRefs: [],
      evidenceLinks: [],
    });
  });

  it("admits only the scopes a workspace read enforces: user and organization are refused", () => {
    for (const sharingScope of ["repository", "workspace"]) {
      expect(
        steeringRecordsAppend.input.safeParse({ ...base, sharingScope }).success,
      ).toBe(true);
    }
    for (const sharingScope of ["user", "organization"]) {
      expect(
        steeringRecordsAppend.input.safeParse({ ...base, sharingScope }).success,
      ).toBe(false);
    }
  });

  it("answers the appended id, hash, kind, idempotency and the proposal it opened", () => {
    const out = steeringRecordsAppend.output.parse({
      recordId: "cta_1",
      recordHash: `sha256:${"a".repeat(64)}`,
      kind: "record_proposal",
      appended: true,
      proposalId: "prp_1",
    });
    expect(out.proposalId).toBe("prp_1");
    expect(
      steeringRecordsAppend.output.safeParse({
        recordId: "cta_1",
        recordHash: "x",
        kind: "directive",
        appended: true,
        proposalId: null,
      }).success,
    ).toBe(false);
  });
});
