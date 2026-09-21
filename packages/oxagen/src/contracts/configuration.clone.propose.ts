import { z } from "zod";
import { registerCapability } from "../registry";
import { configurationCloneDraftSchema } from "../configuration-clone";

export const configurationClonePropose = registerCapability({
  name: "propose_configuration_clone",
  domain: "configuration",
  mode: "sync",
  description:
    "Validate a clone draft and open a create-only proposal under its new identity. Refuses changed source content or a name held by another record or proposal. Retiring the original is separate.",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  mutates: true,
  noBillingGate: true,
  sensitivity: "high",
  defaultEffect: "deny",
  agent: {
    requiresApproval: true,
    riskLevel: "high",
    category: "configuration",
  },
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: configurationCloneDraftSchema,
  output: z
    .object({
      slug: z.string(),
      proposalId: z.string().nullable(),
      pullRequest: z
        .object({ number: z.number().int().positive(), url: z.string() })
        .strict()
        .nullable(),
    })
    .strict(),
});
