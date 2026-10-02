import { describe, expect, it } from "vitest";
import { steeringRecordRevise } from "./steering.record.revise";
import { steeringPrOpen } from "./steering.pr.open";
import { getCapability } from "../registry";

describe("steering.record.revise capability", () => {
  it("registers under its verb-first name", () => {
    expect(getCapability("revise_steering_record")).toBe(steeringRecordRevise);
  });

  it("is an api-only, high-sensitivity, default-deny governance write", () => {
    expect(steeringRecordRevise.surfaces).toEqual(["api", "agent"]);
    expect(steeringRecordRevise.sensitivity).toBe("high");
    expect(steeringRecordRevise.defaultEffect).toBe("deny");
    expect(steeringRecordRevise.mutates).toBe(true);
  });

  // An revision is a governance change, not a billed unit of work, and an
  // agent that reaches for it waits for a human.
  it("gates on approval and skips the billing meter", () => {
    expect(steeringRecordRevise.agent?.requiresApproval).toBe(true);
    expect(steeringRecordRevise.noBillingGate).toBe(true);
  });

  // ── input ─────────────────────────────────────────────────────────────────

  it("accepts a lineage and a new statement", () => {
    const parsed = steeringRecordRevise.input.parse({
      recordId: "ctx.release.no-reread-changelog",
      statement: "Read CHANGELOG.md at most once per run.",
    });
    expect(parsed.rationale).toBeUndefined();
  });

  it("accepts a rationale", () => {
    const parsed = steeringRecordRevise.input.parse({
      recordId: "ctr_7k2m9q4x8r1t5v3w6y0z2a",
      statement: "Read CHANGELOG.md at most once per run.",
      rationale: "The old wording read as a ban on reading it at all.",
    });
    expect(parsed.rationale).toContain("old wording");
  });

  it("rejects an empty statement (negative)", () => {
    expect(() =>
      steeringRecordRevise.input.parse({
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
        steeringRecordRevise.input.parse({
          recordId: "ctx.release.no-reread-changelog",
          statement: "Read CHANGELOG.md at most once per run.",
          ...extra,
        }),
      ).toThrow();
    }
  });

  it("rejects a statement past the 2000-character cap (negative)", () => {
    expect(() =>
      steeringRecordRevise.input.parse({
        recordId: "ctx.release.no-reread-changelog",
        statement: "a".repeat(2001),
      }),
    ).toThrow();
  });

  // ── output ────────────────────────────────────────────────────────────────

  // An revision ends on the same steering PR as a proposal, so it answers with
  // the same shape. Two spellings of one answer would drift.
  it("answers with the steering PR shape open_steering_pr answers with", () => {
    expect(steeringRecordRevise.output).toBe(steeringPrOpen.output);
  });

  it("parses a PR that opened and is running its checks", () => {
    const parsed = steeringRecordRevise.output.parse({
      proposalId: "prp_01k5ru4a",
      lineageId: "ctx.release.no-reread-changelog",
      kind: "rule",
      status: "checks_running",
      governanceMode: "team",
      pr: {
        number: 412,
        url: "https://github.com/acme/core/pull/412",
        provider: "github",
        repository: "acme/core",
        baseRef: "main",
        branch: "context/ctx.release.no-reread-changelog",
        headSha: null,
        path: ".oxagen/rules/ctx.release.no-reread-changelog.toml",
      },
      raised: {
        statement: "Do not re-read CHANGELOG.md more than once in a run.",
        rationale: "Three runs needed it.",
        source: "user:7a000000-0000-4000-8000-0000000000b1",
        sourceName: null,
        force: "should",
        constraintEffect: null,
        sharingScope: "workspace",
        support: { runs: [], agents: [], recordIds: [], evidenceLinks: [] },
        at: "2026-09-30T08:00:00.000Z",
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
      closed: null,
    });
    expect(parsed.pr?.number).toBe(412);
  });

  it("rejects a pull request numbered zero (negative)", () => {
    expect(() =>
      steeringRecordRevise.output.parse({
        proposalId: "prp_01k5ru4a",
        lineageId: "ctx.release.no-reread-changelog",
        kind: "rule",
        status: "pr_open",
        governanceMode: null,
        pr: {
          number: 0,
          url: "https://github.com/acme/core/pull/0",
          provider: "github",
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
