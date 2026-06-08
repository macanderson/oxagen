import { z } from "zod";
import { registerCapability } from "../registry";

export const formCreate = registerCapability({
  name: "form.create",
  domain: "form",
  description: "Create a new form with optional field definitions",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "form" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    title: z.string().min(1),
    fields: z.array(z.unknown()).optional(),
  }),
  output: z.object({
    form_id: z.string(),
    title: z.string(),
    created_at: z.string(),
  }),
});

export type FormCreateInput = z.output<typeof formCreate.input>;
export type FormCreateOutput = z.output<typeof formCreate.output>;
