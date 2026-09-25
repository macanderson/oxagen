// The context-record wizard's two writes through the kernel seam (actions.ts):
// the viewer and the kernel call are the fakes. propose_record gets the
// record the operator chose and the description as its rationale, with no
// support. open_context_pr gets the proposal id, and the action narrows its
// answer to what the wizard's last screen shows. A refusal comes back as it
// was, with nothing else run.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireViewer, kernelWrite } = vi.hoisted(() => ({
  requireViewer: vi.fn(),
  kernelWrite: vi.fn(),
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", () => ({ requireViewer }));
vi.mock("@/server/kernel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/kernel")>()),
  kernelWrite,
}));

const { contextProposalCreate } = await import(
  "@oxagen/oxagen/contracts/context.proposal.create"
);
const { contextPrOpen } = await import(
  "@oxagen/oxagen/contracts/context.pr.open"
);
const { openRecordPr, proposeRecord } = await import("./actions");

const CTX = { orgSlug: "acme", wsSlug: "core-platform" };

const RECORD = {
  lineageId: "ctx.core.cache-changelog",
  kind: "constraint" as const,
  force: "must" as const,
  constraintEffect: "forbid" as const,
  sharingScope: "workspace" as const,
  statement: "Do not re-read CHANGELOG.md in a run.",
};

const CONTEXT_PR = {
  proposalId: "prp_01K5ABC",
  lineageId: RECORD.lineageId,
  status: "checks_passed",
  governanceMode: "solo",
  pr: {
    number: 527,
    url: "https://github.com/acme/platform/pull/527",
    repository: "acme/platform",
    baseRef: "main",
    branch: "context/ctx.core.cache-changelog",
    headSha: "abc1234",
    path: ".oxagen/rules/ctx.core.cache-changelog.toml",
  },
  record: null,
  body: "the body",
  checks: [
    {
      name: "schema",
      status: "passed",
      summary: "one record",
      detailsUrl: "https://github.com/acme/platform/runs/1",
      startedAt: "2026-09-19T10:00:00Z",
      completedAt: "2026-09-19T10:00:01Z",
    },
  ],
  onMerge: {
    publishes: { lineageId: RECORD.lineageId, path: "p" },
    bundleVersion: { current: 3, afterMerge: 4 },
    review: null,
  },
  merged: null,
};

beforeEach(() => {
  requireViewer.mockReset().mockResolvedValue(CTX);
  kernelWrite.mockReset();
});

describe("proposeRecord", () => {
  it("sends the record and the trimmed description, and returns the proposal id", async () => {
    kernelWrite.mockResolvedValue({
      ok: true,
      value: {
        proposalId: "prp_01K5ABC",
        lineageId: RECORD.lineageId,
        status: "proposed",
      },
    });
    const result = await proposeRecord("acme", "core-platform", {
      record: RECORD,
      rationale: "  Agents re-read it every turn  ",
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(kernelWrite).toHaveBeenCalledWith(CTX, contextProposalCreate, {
      record: RECORD,
      rationale: "Agents re-read it every turn",
      support: {},
      // A create never revises an existing lineage (ADR-174).
      createOnly: true,
    });
    expect(result).toEqual({
      ok: true,
      value: { proposalId: "prp_01K5ABC", lineageId: RECORD.lineageId },
    });
  });

  it("hands a refusal back as it was (negative)", async () => {
    const refusal = {
      ok: false,
      reason: "denied",
      code: "org_role_required",
    };
    kernelWrite.mockResolvedValue(refusal);
    expect(
      await proposeRecord("acme", "core-platform", {
        record: RECORD,
        rationale: "why",
      }),
    ).toEqual(refusal);
  });
});

describe("openRecordPr", () => {
  it("opens the Context PR and keeps what the last screen shows", async () => {
    kernelWrite.mockResolvedValue({ ok: true, value: CONTEXT_PR });
    const result = await openRecordPr("acme", "core-platform", "prp_01K5ABC");
    expect(kernelWrite).toHaveBeenCalledWith(CTX, contextPrOpen, {
      proposalId: "prp_01K5ABC",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        proposalId: "prp_01K5ABC",
        lineageId: RECORD.lineageId,
        status: "checks_passed",
        pr: {
          number: 527,
          url: "https://github.com/acme/platform/pull/527",
          repository: "acme/platform",
          branch: "context/ctx.core.cache-changelog",
          path: ".oxagen/rules/ctx.core.cache-changelog.toml",
        },
        checks: [{ name: "schema", status: "passed", summary: "one record" }],
      },
    });
  });

  it("answers a null pull request while none is open (empty)", async () => {
    kernelWrite.mockResolvedValue({
      ok: true,
      value: { ...CONTEXT_PR, status: "proposed", pr: null, checks: [] },
    });
    const result = await openRecordPr("acme", "core-platform", "prp_01K5ABC");
    expect(result).toMatchObject({ ok: true, value: { pr: null, checks: [] } });
  });

  it("hands a conflict back as it was (negative)", async () => {
    const refusal = {
      ok: false,
      reason: "conflict",
      code: "lineage_pr_open",
    };
    kernelWrite.mockResolvedValue(refusal);
    expect(await openRecordPr("acme", "core-platform", "prp_01K5ABC")).toEqual(
      refusal,
    );
  });
});
