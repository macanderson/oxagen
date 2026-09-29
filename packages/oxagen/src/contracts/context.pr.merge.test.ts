import { describe, expect, it } from "vitest";
import { contextPrMerge } from "./context.pr.merge";

describe("merge_context_pr contract", () => {
  it("is the publication: a governed write with approval, unmetered, role-checked in the handler by governance mode", () => {
    expect(contextPrMerge.name).toBe("merge_context_pr");
    expect(contextPrMerge.mutates).toBe(true);
    expect(contextPrMerge.noBillingGate).toBe(true);
    expect(contextPrMerge.agent?.requiresApproval).toBe(true);
    expect(contextPrMerge.sensitivity).toBe("high");
    // The reviewer is a signed-in user; an API key carries none.
    expect(contextPrMerge.surfaces).toEqual(["api"]);
    expect(contextPrMerge.layers).not.toContain("mcp");
  });

  it("answers the published record, the merge commit, the promotion event and the version bump", () => {
    const out = contextPrMerge.output.parse({
      proposalId: "prp_1",
      status: "merged",
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
    });
    expect(out.bundleVersion.after).toBe(out.promotionEvent.seq);
    expect(out.publishedVersion).toBeNull();
  });

  it("answers the steering version a merge published apart from the ledger count (#4732)", () => {
    const out = contextPrMerge.output.parse({
      proposalId: "prp_2",
      status: "merged",
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
});
