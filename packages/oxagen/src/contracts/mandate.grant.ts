import { z } from "zod";
import { registerCapability } from "../registry";
import { mandateGrantInputSchema, mandateSchema } from "../mandates/schemas";

// grant_mandate — bounded, expiring authority for a consequence, to one agent
// (MC spec §6.9 part 3, App. E; ADR-059). A settings write on an identity,
// outside the metering surface (ADR-052 exclusion 2). Roles come from the
// workspace's consequence roles, checked in the handler for every tag on the
// mandate (INV-29); the contract's defaultRoles document the widest set.
//
// With `requestId` the grant activates the draft `request_mandate` created,
// replacing the draft's body with the granter's; without it a new active
// mandate is inserted. A pattern matching no declared tool, or a matched tool
// whose version declares no measure for a named limit, is refused: denied by
// construction (§6.9 rule 1).
export const mandateGrant = registerCapability({
  name: "grant_mandate",
  domain: "mandate",
  description:
    "Grant an agent bounded, expiring authority for a consequence: limits over the tool's declared measures, allowed targets, tool patterns, the mandate's own approval rule, a purpose and a validity window. Activates a requested draft when requestId is given.",
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
  input: mandateGrantInputSchema,
  output: mandateSchema,
});

export type MandateGrantInput = z.output<typeof mandateGrant.input>;
export type MandateGrantOutput = z.output<typeof mandateGrant.output>;
