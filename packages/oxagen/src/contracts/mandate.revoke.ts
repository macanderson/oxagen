import { z } from "zod";
import { registerCapability } from "../registry";
import { mandateIdSchema, mandateSchema } from "../mandates/schemas";

// revoke_mandate — end a mandate. Reservations held by calls that have not
// dispatched (parked for approval) are released in the same transaction, so
// revoking ends in-flight calls that have not dispatched (§6.9). A draft is
// revoked the same way: that is how a request is declined. Roles: the
// consequence roles of every tag on the mandate (INV-29).
export const mandateRevoke = registerCapability({
  name: "revoke_mandate",
  domain: "mandate",
  description:
    "Revoke a mandate with a reason. Releases every reservation held by a call that has not dispatched; an already ended mandate is refused.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "governance" },
  sensitivity: "high",
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: {
      Owner: "allow",
      Admin: "allow",
      Billing: "allow",
      Compliance: "allow",
    },
    workspace: {},
  },
  input: z
    .object({
      mandateId: mandateIdSchema,
      reason: z.string().min(1).max(2000),
    })
    .strict(),
  output: mandateSchema,
});

export type MandateRevokeInput = z.output<typeof mandateRevoke.input>;
export type MandateRevokeOutput = z.output<typeof mandateRevoke.output>;
