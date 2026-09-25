import { z } from "zod";
import { registerCapability } from "../registry";
import { mandateBodySchema, mandateSchema } from "../mandates/schemas";

// request_mandate — an agent operator asks for authority (Agents › mandates,
// MC spec §14 page 3; ADR-059). Creates a `draft` the accountable role
// activates with grant_mandate(requestId) or ends with revoke_mandate. A
// draft grants nothing: the gate reads active mandates only.
export const mandateRequest = registerCapability({
  name: "request_mandate",
  domain: "mandate",
  description:
    "Ask for a mandate on behalf of an agent: the same shape as grant_mandate, recorded as a draft for the role accountable for the consequence to grant or decline.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "governance" },
  sensitivity: "medium",
  mutates: true,
  defaultEffect: "deny",
  // Matches the handler's own assertOrgRole call (ACCOUNTABLE_ORG_ROLES:
  // Owner/Admin/Billing/Compliance; workspace Owner/Member); the previous
  // org set here (Owner, Admin, Member) both invented a nonexistent org
  // "Member" role (tools/scripts/seed-iam-defaults.ts's ORG_ROLES has no
  // such entry, so it seeded nothing) and left out Billing/Compliance, which
  // the handler already admits. An enterprise-org Billing or Compliance
  // user was refused by the kernel before ever reaching that check
  // (ADR-107, #3138).
  defaultRoles: {
    org: {
      Owner: "allow",
      Admin: "allow",
      Billing: "allow",
      Compliance: "allow",
    },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: mandateBodySchema,
  output: mandateSchema,
});

export type MandateRequestInput = z.output<typeof mandateRequest.input>;
export type MandateRequestOutput = z.output<typeof mandateRequest.output>;
