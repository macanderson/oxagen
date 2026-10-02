import { describe, expect, it } from "vitest";
import { contextPrMerge, type ContextPrMergeOutput } from "./context.pr.merge";

/** The record arm of the output, or a failure naming the other arms. */
function recordArm(out: ContextPrMergeOutput) {
  if (!("record" in out)) throw new Error("expected a record merge");
  return out;
}

describe("merge_context_pr contract", () => {
  it("is the publication: a governed write with approval, unmetered, role-checked in the handler by governance mode", () => {
    expect(contextPrMerge.name).toBe("merge_context_pr");
    expect(contextPrMerge.mutates).toBe(true);
    expect(contextPrMerge.noBillingGate).toBe(true);
    expect(contextPrMerge.agent?.requiresApproval).toBe(true);
    expect(contextPrMerge.sensitivity).toBe("high");
    // The reviewer is a signed-in user; an API key carries none.
    expect(contextPrMerge.surfaces).toEqual(["api", "agent"]);
    expect(contextPrMerge.layers).not.toContain("mcp");
  });

  it("answers the published record, the merge commit, the promotion event and the version bump", () => {
    const out = recordArm(
      contextPrMerge.output.parse({
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
    const out = contextPrMerge.output.parse({
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
    expect(contextPrMerge.output.safeParse(base).success).toBe(false);
    expect(
      contextPrMerge.output.safeParse({ ...base, publishedVersion: 0 }).success,
    ).toBe(false);
  });

  it("answers a governance merge with the mode and the file, and no record or promotion event (#4795)", () => {
    const out = contextPrMerge.output.parse({
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
      contextPrMerge.output.safeParse({
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
      contextPrMerge.output.safeParse({
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

  it("answers a steering PR merge with the pull request and the records it retired (#5122)", () => {
    for (const kind of [
      "revert",
      "tools",
      "import",
      "memory_pr",
      "agent_file",
      "agent_proposal",
    ] as const) {
      const out = contextPrMerge.output.parse({
        proposalId: "prp_7",
        status: "merged",
        kind,
        pullRequest: { number: 520, branch: "steering/revert-519" },
        retired: kind === "revert" ? ["ctx.release.no-reread-changelog"] : [],
        mergedCommit: "d4e5f6",
        bundleVersion: { before: 3, after: kind === "revert" ? 4 : 3 },
        publishedVersion: 12,
      });
      expect(out).toMatchObject({ kind, pullRequest: { number: 520 } });
      expect(out).not.toHaveProperty("record");
    }
  });

  it("refuses a steering PR merge that carries a record or names no pull request", () => {
    const base = {
      proposalId: "prp_8",
      status: "merged",
      kind: "tools",
      pullRequest: { number: 7, branch: "tools/billing" },
      retired: [],
      mergedCommit: "e5",
      bundleVersion: { before: 0, after: 0 },
      publishedVersion: 2,
    };
    expect(contextPrMerge.output.safeParse(base).success).toBe(true);
    expect(
      contextPrMerge.output.safeParse({
        ...base,
        record: { id: "ctr_8", lineageId: "l", version: 1, path: "p" },
      }).success,
    ).toBe(false);
    expect(
      contextPrMerge.output.safeParse({ ...base, pullRequest: undefined })
        .success,
    ).toBe(false);
  });
});
