// The steering mappers over real contract-output samples: each output maps
// into a view model its schema accepts, a record no Context PR wrote keeps its
// nulls, a proposal before its pull request carries none, and the Context PR
// carries its checks, what merge will do and, once merged, the promotion.
import { describe, expect, it } from "vitest";
import { ContextPr, ProposalPage, RecordPage } from "@/data/contracts/steering";
import {
  contextPrOutput,
  LINEAGE,
  PR_URL,
  proposalOutput,
  RECORD_PATH,
  recordOutput,
  recordsOutput,
} from "@/test/steering-outputs";
import { toContextPr, toProposalPage, toRecordPage } from "./steering";

describe("toRecordPage", () => {
  it("keeps each record's classification, commit and file, and the total", () => {
    const view = RecordPage.parse(toRecordPage(recordsOutput(undefined, 7)));
    expect(view.total).toBe(7);
    expect(view.records).toEqual([
      {
        id: "ctr_7k2m9q4x8r1t5v3w6y0z2a",
        lineage: LINEAGE,
        title: "Read CHANGELOG.md once per run",
        kind: "constraint",
        force: "must",
        constraintEffect: "forbid",
        sharingScope: "workspace",
        statement: "Do not re-read CHANGELOG.md after the first read in a run.",
        version: 1,
        commit: "4d5e6f7a8b9c",
        path: RECORD_PATH,
        publishedAt: "2026-09-15T09:16:40.000Z",
      },
    ]);
  });

  it("keeps the nulls of a record publish_context_record wrote, never inventing a kind or a commit", () => {
    const view = RecordPage.parse(
      toRecordPage(
        recordsOutput([
          recordOutput({
            kind: null,
            force: null,
            constraintEffect: null,
            statement: null,
            version: null,
            commit: null,
            path: null,
            publishedAt: null,
          }),
        ]),
      ),
    );
    expect(view.records[0]).toMatchObject({
      kind: null,
      force: null,
      statement: null,
      commit: null,
      path: null,
      publishedAt: null,
    });
  });
});

describe("toProposalPage", () => {
  it("keeps the support, the state and the check tally of a proposal with a pull request", () => {
    const view = ProposalPage.parse(
      toProposalPage({ proposals: [proposalOutput()], total: 1 }),
    );
    expect(view.proposals[0]).toMatchObject({
      id: "prp_01k5ru4a",
      status: "checks_passed",
      support: {
        runs: ["arun_01k5rs7m", "arun_01k5rs9q", "arun_01k5rt2c"],
        agents: ["release-bot", "docs-bot"],
        recordIds: ["cta_01k5rt6c"],
        evidenceLinks: ["frame:arun_01k5rs7m/14"],
      },
      pr: {
        number: 519,
        repository: "acme/core-platform",
        branch: `context/${LINEAGE}`,
      },
      checks: { passed: 6, total: 6 },
    });
  });

  it("carries no pull request and no tally before a Context PR opens", () => {
    const view = ProposalPage.parse(
      toProposalPage({
        proposals: [
          proposalOutput({ status: "proposed", pr: null, checks: null }),
        ],
        total: 1,
      }),
    );
    expect(view.proposals[0]).toMatchObject({
      status: "proposed",
      pr: null,
      checks: null,
    });
  });
});

describe("toContextPr", () => {
  it("maps the state machine, the pull request, the checks and what merge will do", () => {
    const view = ContextPr.parse(toContextPr(contextPrOutput()));
    expect(view).toMatchObject({
      proposalId: "prp_01k5ru4a",
      status: "checks_passed",
      governanceMode: "team",
      pr: {
        number: 519,
        url: PR_URL,
        baseRef: "main",
        headSha: "9f8e7d6c5b4a",
      },
      onMerge: {
        path: RECORD_PATH,
        bundleVersion: { current: 41, afterMerge: 42 },
      },
      merged: null,
    });
    expect(view.checks.map((check) => [check.name, check.status])).toEqual([
      ["schema", "passed"],
      ["lineage_uniqueness", "passed"],
      ["record_hash", "passed"],
      ["secret_pii_scan", "passed"],
      ["conflict_against_active", "passed"],
      ["constraint_effect", "passed"],
    ]);
  });

  it("carries the promotion event and the published record once merged", () => {
    const view = ContextPr.parse(
      toContextPr(
        contextPrOutput({
          status: "merged",
          merged: {
            commit: "4d5e6f7a8b9c",
            at: "2026-09-15T09:20:00.000Z",
            byUserId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
            promotionEventId: "ctp_8qm2x4",
            recordId: "ctr_7k2m9q4x",
          },
        }),
      ),
    );
    expect(view.merged).toEqual({
      commit: "4d5e6f7a8b9c",
      at: "2026-09-15T09:20:00.000Z",
      promotionEventId: "ctp_8qm2x4",
      recordId: "ctr_7k2m9q4x",
    });
  });

  it("has no pull request, body, checks or mode before the pull request opens", () => {
    const view = ContextPr.parse(
      toContextPr(
        contextPrOutput({
          status: "proposed",
          governanceMode: null,
          pr: null,
          record: null,
          body: null,
          checks: [],
        }),
      ),
    );
    expect(view).toMatchObject({
      status: "proposed",
      governanceMode: null,
      pr: null,
      body: null,
      checks: [],
    });
  });
});
