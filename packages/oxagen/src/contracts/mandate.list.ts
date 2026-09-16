import { z } from "zod";
import { registerCapability } from "../registry";
import {
  agentIdSchema,
  mandateSchema,
  mandateStatusSchema,
} from "../mandates/schemas";

// list_mandates — the ledger view the accountable office reads (Tools ›
// mandates) and the mandates one agent holds (Agents › mandates). Each row
// carries its remaining authority by measure from the ledger (INV-10).
// Readable by an accountable org role (Owner, Admin, Billing, Compliance);
// any other member sees only the mandates of agents they created.
export const mandateList = registerCapability({
  name: "list_mandates",
  domain: "mandate",
  description:
    "List the workspace's mandates with remaining authority by measure, newest first, optionally narrowed to one agent or one status.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
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
    workspace: {},
  },
  input: z
    .object({
      agentId: agentIdSchema.optional(),
      status: mandateStatusSchema.optional(),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .strict(),
  output: z.object({ items: z.array(mandateSchema) }).strict(),
});

export type MandateListInput = z.output<typeof mandateList.input>;
export type MandateListOutput = z.output<typeof mandateList.output>;
