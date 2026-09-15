import { describe, expect, it } from "vitest";
import { ApprovalItem } from "@/data/contracts";
import {
  type ApprovalRequestRow,
  ApprovalMappingError,
  approvalStatus,
  toApprovalCandidate,
  UNRECORDED_APPROVAL_PATHS,
} from "./approvals";

const NOW = new Date("2026-09-12T10:00:00.000Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

/** A row as agent.approval_requests stores it (createApprovalRequest in @oxagen/agent). */
function approvalRow(
  over: Partial<ApprovalRequestRow> = {},
): ApprovalRequestRow {
  return {
    id: "0192d4a8-7c1e-7a00-8000-0000000a9001",
    publicId: "apr_7k2m9q4x8c1v5b3n6z0r2t",
    createdAt: minutes(-2),
    updatedAt: minutes(-2),
    createdByUserId: null,
    updatedByUserId: null,
    orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
    workspaceId: "0192d4a8-7c1e-7a00-8000-00000000c0de",
    executionStepId: null,
    toolCallId: null,
    messageId: "0192d4a8-7c1e-7a00-8000-0000000e5500",
    capabilityName: "workspace.create",
    inputPreview: { name: "Payments", slug: "payments" },
    riskLevel: "high",
    resolution: null,
    resolvedAt: null,
    resolvedByUserId: null,
    note: null,
    expiresAt: minutes(3),
    ...over,
  };
}

describe("approvalStatus", () => {
  it("is pending while unresolved and unexpired", () => {
    expect(approvalStatus(approvalRow(), NOW)).toBe("pending");
  });

  it("is expired once the expiry passes with no resolution written", () => {
    expect(approvalStatus(approvalRow({ expiresAt: minutes(-1) }), NOW)).toBe(
      "expired",
    );
    expect(approvalStatus(approvalRow({ expiresAt: NOW }), NOW)).toBe(
      "expired",
    );
  });

  it.each(["approved", "denied", "expired"] as const)(
    "reports a written %s resolution as it is",
    (resolution) => {
      expect(
        approvalStatus(approvalRow({ resolution, expiresAt: minutes(5) }), NOW),
      ).toBe(resolution);
    },
  );

  it("refuses a resolution outside the table's CHECK", () => {
    expect(() =>
      approvalStatus(approvalRow({ resolution: "maybe" }), NOW),
    ).toThrow(ApprovalMappingError);
  });
});

describe("toApprovalCandidate", () => {
  const ctx = { workspaceSlug: "core-platform", now: NOW };

  it("maps every recorded column and leaves every unrecorded field null", () => {
    expect(toApprovalCandidate(approvalRow(), ctx)).toEqual({
      id: "apr_7k2m9q4x8c1v5b3n6z0r2t",
      runId: null,
      workspaceSlug: "core-platform",
      status: "pending",
      chain: { operatorId: null, agentKey: null, action: null, trigger: null },
      capabilityName: "workspace.create",
      risk: "high",
      sideEffect: null,
      egress: null,
      amount: null,
      counterparty: null,
      mandateId: null,
      policyVersionId: null,
      inputDigest: null,
      tainted: null,
      tier: null,
      requestedAt: "2026-09-12T09:58:00.000Z",
      expiresAt: "2026-09-12T10:03:00.000Z",
      approvers: null,
      rules: null,
      taintSources: null,
    });
  });

  // The read id and the write key differ. resolve_approval and
  // mcp_consent.resolve look the row up by the uuid primary key
  // (`eq(approvalRequests.id, input.approvalId)`), so resolving with this id
  // fails in Postgres with `invalid input syntax for type uuid` until those
  // handlers accept the public id. B4's approve/deny action must not pass
  // `item.id` to either handler before that backend change lands.
  it("uses the row's public_id as the item id, not the uuid the resolve handlers match", () => {
    const row = approvalRow();
    const candidate = toApprovalCandidate(row, ctx);
    expect(candidate.id).toBe(row.publicId);
    expect(candidate.id).not.toBe(row.id);
    expect(candidate.id).toMatch(/^apr_/);
    expect(row.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(Object.values(candidate)).not.toContain(row.id);
  });

  it.each(["low", "medium", "high", "critical"])("maps risk %s", (risk) => {
    expect(
      toApprovalCandidate(approvalRow({ riskLevel: risk }), ctx).risk,
    ).toBe(risk);
  });

  it("refuses a risk level outside the table's CHECK", () => {
    expect(() =>
      toApprovalCandidate(approvalRow({ riskLevel: "severe" }), ctx),
    ).toThrow(ApprovalMappingError);
  });

  it("refuses a public id or slug that is not one", () => {
    expect(() =>
      toApprovalCandidate(approvalRow({ publicId: "not an id" }), ctx),
    ).toThrow();
    expect(() =>
      toApprovalCandidate(approvalRow(), {
        ...ctx,
        workspaceSlug: "Core Platform",
      }),
    ).toThrow();
  });

  // The contract test: a real row, through the view-model schema.
  it("a real row fails ApprovalItem only on the paths the store does not record", () => {
    const parsed = ApprovalItem.safeParse(
      toApprovalCandidate(approvalRow(), ctx),
    );
    expect(parsed.success).toBe(false);
    const paths = parsed.error?.issues.map((i) => i.path.join(".")) ?? [];
    expect([...new Set(paths)].sort()).toEqual(
      [...UNRECORDED_APPROVAL_PATHS].sort(),
    );
  });

  it("parses once those paths are nullable (the contract change to promote)", () => {
    const Promoted = ApprovalItem.extend({
      runId: ApprovalItem.shape.runId.nullable(),
      chain: ApprovalItem.shape.chain.extend({
        operatorId: ApprovalItem.shape.chain.shape.operatorId.nullable(),
        agentKey: ApprovalItem.shape.chain.shape.agentKey.nullable(),
        action: ApprovalItem.shape.chain.shape.action.nullable(),
      }),
      sideEffect: ApprovalItem.shape.sideEffect.nullable(),
      egress: ApprovalItem.shape.egress.nullable(),
      tier: ApprovalItem.shape.tier.nullable(),
      inputDigest: ApprovalItem.shape.inputDigest.nullable(),
      approvers: ApprovalItem.shape.approvers.nullable(),
    });
    expect(
      Promoted.safeParse(toApprovalCandidate(approvalRow(), ctx)).success,
    ).toBe(true);
  });
});
