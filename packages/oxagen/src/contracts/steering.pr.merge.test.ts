import { describe, expect, it } from "vitest";
import { steeringPrMerge, type SteeringPrMergeOutput } from "./steering.pr.merge";

/** The record arm of the output, or a failure naming the other arm. */
function recordArm(out: SteeringPrMergeOutput) {
  if (out.kind === "governance") throw new Error("expected a record merge");
  return out;
}

describe("merge_steering_pr contract", () => {
  it("is the publication: a governed write with approval, unmetered, role-checked in the handler by governance mode", () => {
    expect(steeringPrMerge.name).toBe("merge_steering_pr");
    expect(steeringPrMerge.mutates).toBe(true);
    expect(steeringPrMerge.noBillingGate).toBe(true);
    expect(steeringPrMerge.agent?.requiresApproval).toBe(true);
    expect(steeringPrMerge.sensitivity).toBe("high");
    // The reviewer is a signed-in user; an API key carries none.
    expect(steeringPrMerge.surfaces).toEqual(["api", "agent"]);
    expect(steeringPrMerge.layers).not.toContain("mcp");
  });

  it("answers the published record, the merge commit, the promotion event and the version bump", () => {
    const out = recordArm(
      steeringPrMerge.output.parse({
        proposalId: "prp_1",
        status: "merged",
        kind: "rule",
        record: {
          id: "ctr_1",
          lineageId: "ctx.release.no-reread-changelog",
          version: 1,
          path: ".oxagen/rules/ctx.release.no-reread-changelog.toml",
        },
        mergedCommit: "7d2e91a0",
        promotionEvent: { id: "ctp_1", seq: 42, chainDigest: "f".repeat(64) },
        bundleVersion: { before: 41, after: 42 },
        publishedVersion: null,
      }),
    );
    expect(out.bundleVersion.after).toBe(out.promotionEvent.seq);
    expect(out.publishedVersion).toBeNull();
  });

  it("answers the steering version a merge published apart from the ledger count (#4732)", () => {
    const out = steeringPrMerge.output.parse({
      proposalId: "prp_2",
      status: "merged",
      kind: "constraint",
      record: {
        id: "ctr_2",
        lineageId: "ctx.release.no-reread-changelog",
        version: 1,
        path: "steering/business-rules/ctx.release.no-reread-changelog.md",
      },
      mergedCommit: "8e3f02b1",
      promotionEvent: { id: "ctp_2", seq: 1, chainDigest: "e".repeat(64) },
      bundleVersion: { before: 0, after: 1 },
      publishedVersion: 2,
    });
    // The first commit of a steering repo is version 1 and appends no ledger
    // entry, so the first merge counts one entry and publishes version 2.
    expect(out.bundleVersion.after).toBe(1);
    expect(out.publishedVersion).toBe(2);
  });

  it("requires publishedVersion and refuses a version below 1", () => {
    const base = {
      proposalId: "prp_3",
      status: "merged",
      kind: "fact",
      record: { id: "ctr_3", lineageId: "l", version: 1, path: "p" },
      mergedCommit: "9f",
      promotionEvent: { id: "ctp_3", seq: 1, chainDigest: "d".repeat(64) },
      bundleVersion: { before: 0, after: 1 },
    };
    expect(steeringPrMerge.output.safeParse(base).success).toBe(false);
    expect(
      steeringPrMerge.output.safeParse({ ...base, publishedVersion: 0 }).success,
    ).toBe(false);
  });

  it("answers a governance merge with the mode and the file, and no record or promotion event (#4795)", () => {
    const out = steeringPrMerge.output.parse({
      proposalId: "prp_4",
      status: "merged",
      kind: "governance",
      governance: { mode: "solo", path: "steering/governance.toml" },
      mergedCommit: "a1b2c3d4",
      bundleVersion: { before: 7, after: 7 },
      publishedVersion: 9,
    });
    expect(out).toMatchObject({
      kind: "governance",
      governance: { mode: "solo" },
      bundleVersion: { before: 7, after: 7 },
    });
    expect(out).not.toHaveProperty("record");
    expect(out).not.toHaveProperty("promotionEvent");
  });

  it("refuses a governance merge that carries a record, and a record merge with no kind", () => {
    expect(
      steeringPrMerge.output.safeParse({
        proposalId: "prp_5",
        status: "merged",
        kind: "governance",
        governance: { mode: "team", path: "steering/governance.toml" },
        record: { id: "ctr_5", lineageId: "l", version: 1, path: "p" },
        mergedCommit: "b2",
        bundleVersion: { before: 0, after: 0 },
        publishedVersion: null,
      }).success,
    ).toBe(false);
    expect(
      steeringPrMerge.output.safeParse({
        proposalId: "prp_6",
        status: "merged",
        record: { id: "ctr_6", lineageId: "l", version: 1, path: "p" },
        mergedCommit: "c3",
        promotionEvent: { id: "ctp_6", seq: 1, chainDigest: "c".repeat(64) },
        bundleVersion: { before: 0, after: 1 },
        publishedVersion: null,
      }).success,
    ).toBe(false);
  });
});
