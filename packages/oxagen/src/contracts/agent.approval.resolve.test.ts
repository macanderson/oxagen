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
      mandate: null,
    });
    expect(parsed.resolution).toBe("approved");
  });

  it("carries the mandate settlement on a row the mandate gate parked, and refuses an outcome it cannot produce", () => {
    const parsed = agentApprovalResolve.output.parse({
      approvalId: PUBLIC_ID,
      resolution: "denied",
      mandate: {
        mandateId: "mnd_0123456789abcdefghjkmn",
        reserved: [
          { measure: "amount", value: "250000000", unitOrCurrency: "USD" },
        ],
        outcome: "released",
      },
    });
    expect(parsed.mandate?.outcome).toBe("released");
    expect(
      agentApprovalResolve.output.safeParse({
        approvalId: PUBLIC_ID,
        resolution: "approved",
        mandate: { mandateId: "mnd_x", reserved: [], outcome: "settled" },
      }).success,
    ).toBe(false);
    expect(
      agentApprovalResolve.output.safeParse({
        approvalId: PUBLIC_ID,
        resolution: "approved",
      }).success,
    ).toBe(false);
  });

  it.each(["expired", "stalled"])(
    "rejects the resolution %j: a no-op is a conflict, never a success",
    (resolution) => {
      expect(
        agentApprovalResolve.output.safeParse({
          approvalId: PUBLIC_ID,
          resolution,
          mandate: null,
        }).success,
      ).toBe(false);
    },
  );

  it("is the governed action: declares no noBillingGate", () => {
    expect(
      (agentApprovalResolve as { noBillingGate?: boolean }).noBillingGate,
    ).toBeUndefined();
  });

  it("is not on the agent surface: a person resolves an approval, never a model (ADR-XXX)", () => {
    expect(agentApprovalResolve.surfaces).toEqual(["api", "mcp"]);
    expect(agentApprovalResolve.surfaces).not.toContain("agent");
  });

  it("declares that it writes", () => {
    expect(agentApprovalResolve.mutates).toBe(true);
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("resolve_approval")).toBe(agentApprovalResolve);
  });
});
