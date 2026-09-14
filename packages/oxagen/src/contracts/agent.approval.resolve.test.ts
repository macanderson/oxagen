import { describe, expect, it } from "vitest";
import {
  agentApprovalResolve,
  approvalIdSchema,
  isApprovalPublicId,
} from "./agent.approval.resolve";
import { getCapability } from "../registry";

const PUBLIC_ID = "apr_01k5rt9xq7v3m8n2p4s6t8w0";
const ROW_UUID = "4b2f7a0e-6c1d-4e8a-9f3b-2d5c7e9a1b3c";

describe("agent.approval.resolve capability", () => {
  it("parses a valid approved decision by public id", () => {
    const parsed = agentApprovalResolve.input.parse({
      approvalId: PUBLIC_ID,
      decision: "approved",
    });
    expect(parsed.decision).toBe("approved");
  });

  it("parses a valid denied decision by row uuid, with a note", () => {
    const parsed = agentApprovalResolve.input.parse({
      approvalId: ROW_UUID,
      decision: "denied",
      note: "Out of scope",
    });
    expect(parsed.note).toBe("Out of scope");
  });

  it.each(["appr_1", "apr-1", "apr_", "", "not-a-uuid", "apr_1 "])(
    "refuses an approvalId that is neither form: %j",
    (approvalId) => {
      expect(approvalIdSchema.safeParse(approvalId).success).toBe(false);
      expect(
        agentApprovalResolve.input.safeParse({
          approvalId,
          decision: "approved",
        }).success,
      ).toBe(false);
    },
  );

  it("tells the two forms apart, case-insensitively", () => {
    expect(isApprovalPublicId(PUBLIC_ID)).toBe(true);
    expect(isApprovalPublicId(PUBLIC_ID.toUpperCase())).toBe(true);
    expect(isApprovalPublicId(ROW_UUID)).toBe(false);
    expect(isApprovalPublicId("appr_1")).toBe(false);
  });

  it("rejects an unknown decision", () => {
    expect(() =>
      agentApprovalResolve.input.parse({
        approvalId: PUBLIC_ID,
        decision: "maybe",
      }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = agentApprovalResolve.output.parse({
      approvalId: PUBLIC_ID,
      resolution: "approved",
    });
    expect(parsed.resolution).toBe("approved");
  });

  it.each(["expired", "stalled"])(
    "rejects the resolution %j: a no-op is a conflict, never a success",
    (resolution) => {
      expect(
        agentApprovalResolve.output.safeParse({
          approvalId: PUBLIC_ID,
          resolution,
        }).success,
      ).toBe(false);
    },
  );

  it("is the governed action: declares no noBillingGate", () => {
    expect(
      (agentApprovalResolve as { noBillingGate?: boolean }).noBillingGate,
    ).toBeUndefined();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("resolve_approval")).toBe(agentApprovalResolve);
  });
});
