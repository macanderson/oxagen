import { describe, expect, it } from "vitest";
import { ApprovalItem } from "@/data/contracts";
import {
  type ApprovalRequestRow,
  ApprovalMappingError,
  approvalStatus,
  CommandDelivery,
  type ControlCommandRow,
  commandStatus,
  toApprovalCandidate,
  toCommandDelivery,
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

/** A row as tacho.control_commands stores it (dispatch_tacho_command). */
function commandRow(over: Partial<ControlCommandRow> = {}): ControlCommandRow {
  return {
    id: "0192d4a8-7c1e-7a00-8000-0000000cc001",
    publicId: "tcm_4f8h2k6m0p3r7t1v5x9z2b",
    createdAt: minutes(-1),
    updatedAt: minutes(-1),
    createdByUserId: "0192d4a8-7c1e-7a00-8000-0000000a5e01",
    updatedByUserId: "0192d4a8-7c1e-7a00-8000-0000000a5e01",
    orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
    workspaceId: "0192d4a8-7c1e-7a00-8000-00000000c0de",
    hostId: "0192d4a8-7c1e-7a00-8000-0000000b0571",
    sessionId: null,
    command: "pause",
    payload: { reason: "budget" },
    issuedByPrincipalId: null,
    issuedByUserId: "0192d4a8-7c1e-7a00-8000-0000000a5e01",
    issuedAt: minutes(-1),
    expiresAt: minutes(59),
    deliveredAt: null,
    acknowledgedAt: null,
    appliedAt: null,
    appliedAtSeq: null,
    outcome: "pending",
    outcomeDetail: null,
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

describe("commandStatus (spec §7.4 vocabulary)", () => {
  it("is queued while pending and unexpired, or pending with no expiry", () => {
    expect(commandStatus(commandRow(), NOW)).toBe("queued");
    expect(commandStatus(commandRow({ expiresAt: null }), NOW)).toBe("queued");
  });

  it("is expired when a pending command outlives its expiry", () => {
    expect(commandStatus(commandRow({ expiresAt: minutes(-1) }), NOW)).toBe(
      "expired",
    );
  });

  it("is sent once delivered, and received only after the host acknowledges it", () => {
    expect(
      commandStatus(
        commandRow({ outcome: "delivered", deliveredAt: minutes(-1) }),
        NOW,
      ),
    ).toBe("sent");
    expect(
      commandStatus(
        commandRow({ outcome: "delivered", acknowledgedAt: minutes(0) }),
        NOW,
      ),
    ).toBe("received");
  });

  it.each(["applied", "expired", "failed"] as const)(
    "reports a terminal %s outcome as it is, whatever the expiry",
    (outcome) => {
      expect(
        commandStatus(commandRow({ outcome, expiresAt: minutes(-5) }), NOW),
      ).toBe(outcome);
    },
  );

  it("never reports acknowledged, draft or cancelled: tacho records none of them", () => {
    const produced = new Set(
      (
        ["pending", "delivered", "applied", "expired", "failed"] as const
      ).flatMap((outcome) =>
        [null, minutes(0)].flatMap((acknowledgedAt) =>
          [null, minutes(-1), minutes(1)].map((expiresAt) =>
            commandStatus(
              commandRow({ outcome, acknowledgedAt, expiresAt }),
              NOW,
            ),
          ),
        ),
      ),
    );
    expect(produced.has("acknowledged")).toBe(false);
    expect(produced.has("draft")).toBe(false);
    expect(produced.has("cancelled")).toBe(false);
  });

  it("refuses an outcome outside the table's CHECK", () => {
    expect(() => commandStatus(commandRow({ outcome: "lost" }), NOW)).toThrow(
      ApprovalMappingError,
    );
  });
});

describe("toCommandDelivery", () => {
  it("parses a real applied row through CommandDelivery", () => {
    const row = commandRow({
      outcome: "applied",
      deliveredAt: minutes(-1),
      acknowledgedAt: minutes(0),
      appliedAt: minutes(0),
      appliedAtSeq: 412,
      outcomeDetail: "paused at next prompt",
    });
    expect(CommandDelivery.parse(toCommandDelivery(row, NOW))).toEqual({
      id: "tcm_4f8h2k6m0p3r7t1v5x9z2b",
      command: "pause",
      status: "applied",
      issuedAt: "2026-09-12T09:59:00.000Z",
      expiresAt: "2026-09-12T10:59:00.000Z",
      deliveredAt: "2026-09-12T09:59:00.000Z",
      acknowledgedAt: "2026-09-12T10:00:00.000Z",
      appliedAt: "2026-09-12T10:00:00.000Z",
      appliedAtSeq: 412,
      detail: "paused at next prompt",
    });
  });

  it("keeps unrecorded instants null", () => {
    const d = toCommandDelivery(commandRow({ expiresAt: null }), NOW);
    expect(d).toMatchObject({
      expiresAt: null,
      deliveredAt: null,
      acknowledgedAt: null,
      appliedAt: null,
      appliedAtSeq: null,
      detail: null,
    });
    expect(CommandDelivery.safeParse(d).success).toBe(true);
  });

  it("refuses a command outside TACHO_COMMANDS", () => {
    expect(() =>
      toCommandDelivery(commandRow({ command: "steer" }), NOW),
    ).toThrow(ApprovalMappingError);
  });
});
