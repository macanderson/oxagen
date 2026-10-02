// promote_instruction_to_steering (S7, #4518; ADR-263): a statement that
// contradicts a steering record becomes a proposal for that record, and its
// steering PR opens. Every refusal comes before anything is written. The
// finding store is in memory, the steering store and open_steering_pr are
// fakes that record their calls.
import { HandlerError } from "@oxagen/oxagen";
import type { SteeringPrOpenOutput } from "@oxagen/oxagen/contracts/steering.pr.open";
import { instructionPromote } from "@oxagen/oxagen/contracts/repository.instruction.promote";
import { describe, expect, it, vi } from "vitest";
import { ctx, SCOPE } from "../context.steering.test-support";
import type { PublishedStatement } from "./findings";
import {
  createPromoteInstructionHandler,
  PROMOTED_STATEMENT_MAX,
  proposalKindOf,
  type PromoteDeps,
} from "./promote";
import { memoryFindingStore } from "./store.test-support";

const LINEAGE = "a-intel.platform.no-push-to-main";
const RECORDS: PublishedStatement[] = [
  {
    lineage: LINEAGE,
    label: "Never push to main",
    kind: "constraint",
    effect: "forbid",
    statement:
      "Do not push to `main` or force-push any shared branch. Open a pull request\nfrom a branch named for the work.",
    path: "steering/platform/a-intel.platform.no-push-to-main.md",
  },
  {
    lineage: "a-intel.platform.tenant-queries",
    label: "Scope every tenant query",
    kind: "code-rule",
    effect: null,
    statement: "Run every tenant query inside withTenantDb so row level security applies to it.",
    path: "steering/platform/a-intel.platform.tenant-queries.md",
  },
];
const CONTRADICTION = "Always push to `main` or force-push any shared branch.";
const HEAD = "9b1f6c0d2e3a4b5c6d7e8f90a1b2c3d4e5f60718";
const PR_URL = "https://github.com/a-intel/platform/pull/318";

function setup(over: {
  statement?: string;
  kind?: string;
  openPr?: { prUrl: string | null; publicId: string } | null;
} = {}) {
  const findings = memoryFindingStore([
    {
      orgId: SCOPE.orgId,
      workspaceId: SCOPE.workspaceId,
      publicId: "crf_contra",
      provider: "github",
      providerRepositoryId: "771020341",
      repository: "a-intel/platform",
      pullRequestNumber: 318,
      pullRequestUrl: PR_URL,
      pullRequestState: "open",
      headSha: HEAD,
      path: "AGENTS.md",
      line: 3,
      statement: over.statement ?? CONTRADICTION,
      proposalPublicId: null,
      checkedAt: new Date("2026-10-02T14:12:10.000Z"),
    },
  ]);
  findings.links.set("github:771020341", "rpb_link01");
  const inserted: Record<string, unknown>[] = [];
  const steering = {
    findRecord: vi.fn(async () => ({
      record: {
        kind: over.kind ?? "constraint",
        force: "must",
        sharingScope: "workspace",
      },
      versions: [],
      publishedBy: null,
    })),
    findOpenPrOnLineage: vi.fn(async () => over.openPr ?? null),
    insertProposal: vi.fn(async (values: Record<string, unknown>) => {
      inserted.push(values);
      return { ...values, publicId: "prp_new1" };
    }),
  };
  const openPr = vi.fn(
    async () =>
      ({
        status: "checks_passed",
        pr: { number: 7, url: "https://github.com/a-intel/oxagen-platform/pull/7" },
      }) as unknown as SteeringPrOpenOutput,
  );
  const assertRole = vi.fn(async () => undefined);
  const deps = {
    findings,
    publishedRecords: vi.fn(async () => RECORDS),
    steering: steering as unknown as PromoteDeps["steering"],
    openPr,
    assertRole,
  };
  return { handler: createPromoteInstructionHandler(deps), findings, steering, inserted, openPr, assertRole };
}

async function refusal(run: Promise<unknown>): Promise<HandlerError> {
  try {
    await run;
  } catch (err) {
    return err as HandlerError;
  }
  throw new Error("The promote went through, and the test expected a refusal.");
}

describe("promote_instruction_to_steering", () => {
  it("proposes the contradicted record with the line as its text, and opens its steering PR", async () => {
    const { handler, inserted, openPr, findings } = setup();
    const out = await handler({ finding_id: "crf_contra" }, ctx());
    expect(instructionPromote.output.safeParse(out).success).toBe(true);
    expect(out).toEqual({
      proposal_id: "prp_new1",
      lineage: LINEAGE,
      status: "checks_passed",
      pull_request: { number: 7, url: "https://github.com/a-intel/oxagen-platform/pull/7" },
    });
    expect(inserted).toEqual([
      expect.objectContaining({
        orgId: SCOPE.orgId,
        workspaceId: SCOPE.workspaceId,
        lineageId: LINEAGE,
        kind: "constraint",
        force: "must",
        // "Always" requires, where the record forbids.
        constraintEffect: "require",
        sharingScope: "workspace",
        statement: CONTRADICTION,
        source: "a-intel/platform/AGENTS.md",
        evidenceLinks: [PR_URL, `https://github.com/a-intel/platform/blob/${HEAD}/AGENTS.md#L3`],
      }),
    ]);
    expect(inserted[0]?.rationale).toContain("AGENTS.md line 3 in a-intel/platform says the opposite of the steering record Never push to main.");
    expect(openPr).toHaveBeenCalledWith({ proposalId: "prp_new1" }, expect.anything());
    // The finding names its proposal, so the page shows it and a second
    // promote is refused.
    expect(findings.rows[0]?.proposalPublicId).toBe("prp_new1");
  });

  it("proposes a code rule as a rule, which keeps its kind in the steering repo", () => {
    expect(proposalKindOf("code-rule")).toBe("rule");
    expect(proposalKindOf("business-rule")).toBe("rule");
    expect(proposalKindOf("constraint")).toBe("constraint");
    expect(proposalKindOf("skill")).toBeNull();
  });

  it("refuses a repeat, which is in steering already (negative)", async () => {
    const { handler, steering, openPr } = setup({
      statement: "Run every tenant query inside withTenantDb so row level security applies to it.",
    });
    const err = await refusal(handler({ finding_id: "crf_contra" }, ctx()));
    expect(err).toMatchObject({ code: "conflict", reason: "already_in_steering" });
    expect(err.message).toContain("Remove the line from the file instead.");
    expect(steering.insertProposal).not.toHaveBeenCalled();
    expect(openPr).not.toHaveBeenCalled();
  });

  it("refuses a statement that matches no record now (negative)", async () => {
    const { handler, steering } = setup({ statement: "The staging database resets every Sunday night." });
    await expect(handler({ finding_id: "crf_contra" }, ctx())).rejects.toMatchObject({
      reason: "finding_resolved",
    });
    expect(steering.insertProposal).not.toHaveBeenCalled();
  });

  it("refuses while the finding's proposal is still open, and promotes again once it was dismissed", async () => {
    const { handler, findings, steering } = setup();
    await findings.setProposal(SCOPE, "crf_contra", "prp_earlier");
    findings.proposals.set("prp_earlier", "pr_open");
    await expect(handler({ finding_id: "crf_contra" }, ctx())).rejects.toMatchObject({
      reason: "already_proposed",
    });
    expect(steering.insertProposal).not.toHaveBeenCalled();

    findings.proposals.set("prp_earlier", "rejected");
    await expect(handler({ finding_id: "crf_contra" }, ctx())).resolves.toMatchObject({
      proposal_id: "prp_new1",
    });
  });

  it("refuses while another PR is open on the record (negative)", async () => {
    const { handler, steering } = setup({
      openPr: { prUrl: "https://github.com/a-intel/oxagen-platform/pull/5", publicId: "prp_other" },
    });
    const err = await refusal(handler({ finding_id: "crf_contra" }, ctx()));
    expect(err).toMatchObject({ reason: "lineage_pr_open" });
    expect(err.message).toContain("pull/5");
    expect(steering.insertProposal).not.toHaveBeenCalled();
  });

  it("refuses a line longer than a record holds (negative)", async () => {
    // Each pad sentence has three or more words, so sentencesOf keeps it, and
    // the first sentence still contradicts the record on its own.
    const long = `${CONTRADICTION} ${"Keep this note so the line runs past the limit. ".repeat(45)}`;
    expect(long.length).toBeGreaterThan(PROMOTED_STATEMENT_MAX);
    const { handler, steering } = setup({ statement: long });
    await expect(handler({ finding_id: "crf_contra" }, ctx())).rejects.toMatchObject({
      reason: "statement_too_long",
    });
    expect(steering.insertProposal).not.toHaveBeenCalled();
  });

  it("refuses a skill, which a line cannot revise (negative)", async () => {
    const { handler, steering } = setup({ kind: "skill" });
    await expect(handler({ finding_id: "crf_contra" }, ctx())).rejects.toMatchObject({
      reason: "record_not_proposable",
    });
    expect(steering.insertProposal).not.toHaveBeenCalled();
  });

  it("answers not found for a finding in a repository the workspace no longer links (negative)", async () => {
    const { handler, findings } = setup();
    findings.links.clear();
    await expect(handler({ finding_id: "crf_contra" }, ctx())).rejects.toMatchObject({
      code: "not_found",
      reason: "finding_not_found",
    });
  });

  it("writes nothing for a caller the role check refuses (negative)", async () => {
    const { handler, assertRole, steering } = setup();
    assertRole.mockRejectedValueOnce(new HandlerError({ code: "forbidden", reason: "role_not_held" }));
    await expect(handler({ finding_id: "crf_contra" }, ctx())).rejects.toMatchObject({
      reason: "role_not_held",
    });
    expect(steering.insertProposal).not.toHaveBeenCalled();
  });
});
