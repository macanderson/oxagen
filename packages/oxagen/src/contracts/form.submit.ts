import { z } from "zod";
import { registerCapability } from "../registry";

export const formSubmit = registerCapability({
  name: "form.submit",
  domain: "form",
  description: "Submit a response to a form",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "docs", "mcp"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "form" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    form_id: z.string(),
    responses: z.record(z.unknown()).optional(),
  }),
  output: z.object({
    submission_id: z.string(),
    status: z.string(),
    created_at: z.string(),
  }),
});

export type FormSubmitInput = z.output<typeof formSubmit.input>;
export type FormSubmitOutput = z.output<typeof formSubmit.output>;
