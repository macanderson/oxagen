import { describe, expect, it } from "vitest";
import { runEvidenceSubmit } from "./run.evidence.submit";
import { getCapability } from "../registry";

const MINIMAL_INPUT = {
  runId: "run_1",
  principals: { initiatingPrincipalId: "prn_init" },
  localCheckoutSnapshot: { baseCommitSha: "a".repeat(40) },
};

describe("run.evidence.submit capability", () => {
  it("is registered on api/mcp/cli surfaces in the run domain", () => {
    const cap = getCapability("submit_run_evidence");
    expect(cap).toBeDefined();
    expect(cap?.domain).toBe("run");
    expect(cap?.surfaces).toEqual(["api", "mcp", "cli"]);
    expect(cap?.sensitivity).toBe("medium");
  });

  it("input carries NO evidenceAuthority field (invariant 4 — stamped server-side)", () => {
    const parsed = runEvidenceSubmit.input.parse(MINIMAL_INPUT) as Record<
      string,
      unknown
    >;
    expect("evidenceAuthority" in parsed).toBe(false);
    expect("evidence_authority" in parsed).toBe(false);
  });

  it("defaults changes and every receipt array to []", () => {
    const parsed = runEvidenceSubmit.input.parse(MINIMAL_INPUT);
    expect(parsed.changes).toEqual([]);
    expect(parsed.commits).toEqual([]);
    expect(parsed.pullRequestReceipts).toEqual([]);
    expect(parsed.toolReceipts).toEqual([]);
    expect(parsed.approvalReceipts).toEqual([]);
    expect(parsed.verificationReceipts).toEqual([]);
    expect(parsed.artifactDigests).toEqual([]);
  });

  it("requires runId, principals, and a base commit sha", () => {
    expect(() => runEvidenceSubmit.input.parse({})).toThrow();
    expect(() =>
      runEvidenceSubmit.input.parse({
        runId: "run_1",
        localCheckoutSnapshot: { baseCommitSha: "a" },
      }),
    ).toThrow();
    expect(() =>
      runEvidenceSubmit.input.parse({
        runId: "run_1",
        principals: { initiatingPrincipalId: "p" },
        localCheckoutSnapshot: {},
      }),
    ).toThrow();
  });

  it("rejects an unknown change_kind and retention_mode", () => {
    expect(() =>
      runEvidenceSubmit.input.parse({
        ...MINIMAL_INPUT,
        changes: [{ pathLocator: "src/a.ts", changeKind: "moved" }],
      }),
    ).toThrow();
    expect(() =>
      runEvidenceSubmit.input.parse({
        ...MINIMAL_INPUT,
        context: {
          frames: [
            {
              providerId: "cgp",
              frameId: "f1",
              canonicalContentDigest: "d",
              retentionMode: "encrypted",
            },
          ],
        },
      }),
    ).toThrow();
  });

  it("accepts a full manifest with changes and context frames", () => {
    const parsed = runEvidenceSubmit.input.parse({
      ...MINIMAL_INPUT,
      attemptId: "attempt_1",
      changes: [
        {
          pathLocator: "packages/billing/index.ts",
          changeKind: "modified",
          beforeDigest: "before",
          afterDigest: "after",
        },
      ],
      context: {
        compiledFrameManifestDigest: "cfd",
        frames: [
          {
            providerId: "cgp",
            frameId: "f1",
            canonicalContentDigest: "digest",
            retentionMode: "hash_only",
            tokenCost: 128,
          },
        ],
      },
      commits: [{ sha: "abc", message: "fix" }],
      artifactDigests: ["sha256:deadbeef"],
    });
    expect(parsed.changes).toHaveLength(1);
    expect(parsed.context?.frames[0]?.retentionMode).toBe("hash_only");
    expect(parsed.artifactDigests).toEqual(["sha256:deadbeef"]);
  });

  it("parses a submit output", () => {
    const parsed = runEvidenceSubmit.output.parse({
      manifestId: "rem_1",
      manifestDigest: "f".repeat(64),
      deduplicated: false,
    });
    expect(parsed.deduplicated).toBe(false);
  });
});
