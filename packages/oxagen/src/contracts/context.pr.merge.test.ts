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
    });
    expect(out.bundleVersion.after).toBe(out.promotionEvent.seq);
  });
});
