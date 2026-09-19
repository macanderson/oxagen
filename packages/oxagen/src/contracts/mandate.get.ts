import { z } from "zod";
import { registerCapability } from "../registry";
import {
  mandateIdSchema,
  mandateLedgerRowSchema,
  mandateSchema,
} from "../mandates/schemas";

// get_mandate: one mandate with its ledger rows and remaining authority by
// measure (the mandate page: tiles, the ledger, the grant). Same readers as
// list_mandates: the accountable org roles read every mandate; a workspace
// Owner or Member reads the mandates of agents they created (`readerFilter`
// in packages/handlers/src/_mandate.ts already narrows this way, the
// handler was ready before this contract admitted the caller). Without this,
// the page a list row links to refuses the very reader list_mandates just
// admitted (ADR-107, #3138).
export const mandateGet = registerCapability({
  name: "get_mandate",
  domain: "mandate",
  description:
    "Read one mandate: the grant, remaining authority by measure from the ledger, and the ledger rows (reservations, settlements, releases) newest first.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  agent: { requiresApproval: false, riskLevel: "low", category: "governance" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: {
      Owner: "allow",
      Admin: "allow",
      Billing: "allow",
      Compliance: "allow",
    },
    workspace: {
      Owner: "allow",
      Member: "allow",
    },
  },
  input: z
    .object({
      mandateId: mandateIdSchema,
      ledgerLimit: z.number().int().min(1).max(500).default(100),
    })
    .strict(),
  output: z
    .object({
      mandate: mandateSchema,
      ledger: z.array(mandateLedgerRowSchema),
    })
    .strict(),
});

export type MandateGetInput = z.output<typeof mandateGet.input>;
export type MandateGetOutput = z.output<typeof mandateGet.output>;
