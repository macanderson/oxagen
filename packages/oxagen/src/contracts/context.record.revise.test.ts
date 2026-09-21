import { describe, expect, it } from "vitest";
import { contextRecordRevise } from "./context.record.revise";
import { contextPrOpen } from "./context.pr.open";
import { getCapability } from "../registry";

describe("context.record.revise capability", () => {
  it("registers under its verb-first name", () => {
    expect(getCapability("revise_context_record")).toBe(contextRecordRevise);
  });

  it("is an api-only, high-sensitivity, default-deny governance write", () => {
    expect(contextRecordRevise.surfaces).toEqual(["api"]);
    expect(contextRecordRevise.sensitivity).toBe("high");
    expect(contextRecordRevise.defaultEffect).toBe("deny");
    expect(contextRecordRevise.mutates).toBe(true);
  });

  // An revision is a governance change, not a billed unit of work, and an
  // agent that reaches for it waits for a human.
  it("gates on approval and skips the billing meter", () => {
    expect(contextRecordRevise.agent?.requiresApproval).toBe(true);
    expect(contextRecordRevise.noBillingGate).toBe(true);
  });

  // ── input ─────────────────────────────────────────────────────────────────

  it("accepts a lineage and a new statement", () => {
    const parsed = contextRecordRevise.input.parse({
      recordId: "ctx.release.no-reread-changelog",
      statement: "Read CHANGELOG.md at most once per run.",
    });
    expect(parsed.rationale).toBeUndefined();
  });

  it("accepts a rationale", () => {
    const parsed = contextRecordRevise.input.parse({
      recordId: "ctr_7k2m9q4x8r1t5v3w6y0z2a",
      statement: "Read CHANGELOG.md at most once per run.",
      rationale: "The old wording read as a ban on reading it at all.",
    });
    expect(parsed.rationale).toContain("old wording");
  });

  it("rejects an empty statement (negative)", () => {
    expect(() =>
      contextRecordRevise.input.parse({
        recordId: "ctx.release.no-reread-changelog",
        statement: "",
      }),
    ).toThrow();
  });

  // The statement is the only field an revision changes. A caller that sends
  // a kind or a force is asking for a different record, and `propose_record`
  // is where that goes; a lax schema would drop the field and open a PR that
  // silently did not do what was asked.
  it("rejects a kind, a force or any other field (negative)", () => {
    for (const extra of [
      { kind: "rule" },
      { force: "must" },
      { constraintEffect: "deny" },
      { sharingScope: "org" },
    ]) {
      expect(() =>
        contextRecordRevise.input.parse({
          recordId: "ctx.release.no-reread-changelog",
          statement: "Read CHANGELOG.md at most once per run.",
          ...extra,
        }),
      ).toThrow();
    }
  });

  it("rejects a statement past the 2000-character cap (negative)", () => {
    expect(() =>
      contextRecordRevise.input.parse({
        recordId: "ctx.release.no-reread-changelog",
        statement: "a".repeat(2001),
      }),
    ).toThrow();
  });

  // ── output ────────────────────────────────────────────────────────────────

  // An revision ends on the same Context PR as a proposal, so it answers with
  // the same shape. Two spellings of one answer would drift.
  it("answers with the Context PR shape open_context_pr answers with", () => {
    expect(contextRecordRevise.output).toBe(contextPrOpen.output);
  });

  it("parses a PR that opened and is running its checks", () => {
    const parsed = contextRecordRevise.output.parse({
      proposalId: "prp_01k5ru4a",
      lineageId: "ctx.release.no-reread-changelog",
      status: "checks_running",
      governanceMode: "team",
      pr: {
        number: 412,
        url: "https://github.com/acme/core/pull/412",
        repository: "acme/core",
        baseRef: "main",
        branch: "context/ctx.release.no-reread-changelog",
        headSha: null,
        path: ".oxagen/rules/ctx.release.no-reread-changelog.toml",
      },
      record: null,
      body: null,
      checks: [],
      onMerge: {
        publishes: {
          lineageId: "ctx.release.no-reread-changelog",
          path: ".oxagen/rules/ctx.release.no-reread-changelog.toml",
        },
        bundleVersion: { current: 41, afterMerge: 42 },
        review: null,
      },
      merged: null,
    });
    expect(parsed.pr?.number).toBe(412);
  });

  it("rejects a pull request numbered zero (negative)", () => {
    expect(() =>
      contextRecordRevise.output.parse({
        proposalId: "prp_01k5ru4a",
        lineageId: "ctx.release.no-reread-changelog",
        status: "pr_open",
        governanceMode: null,
        pr: {
          number: 0,
          url: "https://github.com/acme/core/pull/0",
          repository: "acme/core",
          baseRef: "main",
          branch: "context/ctx.release.no-reread-changelog",
          headSha: null,
          path: ".oxagen/rules/ctx.release.no-reread-changelog.toml",
        },
        record: null,
        body: null,
        checks: [],
        onMerge: {
          publishes: {
            lineageId: "ctx.release.no-reread-changelog",
            path: ".oxagen/rules/ctx.release.no-reread-changelog.toml",
          },
          bundleVersion: { current: 41, afterMerge: 42 },
          review: null,
        },
        merged: null,
      }),
    ).toThrow();
  });
});
