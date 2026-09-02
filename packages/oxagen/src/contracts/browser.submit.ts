import { z } from "zod";
import { registerCapability } from "../registry";

// Submit the active form on the durable sandbox browser's page — click a submit
// control by selector, or press Enter when no selector is given — then wait for
// the resulting navigation/network to settle.

export const browserSubmit = registerCapability({
  name: "submit_page",
  domain: "browser",
  description:
    "Submit a form on the durable sandbox browser's current page (click the given selector, or press Enter) and wait for the result to settle.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "medium", category: "browser" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    sessionId: z.string().min(1).describe("Durable-session id (sbx_…)."),
    selector: z
      .string()
      .min(1)
      .optional()
      .describe(
        "CSS selector of the submit control. Omit to press Enter on the focused field.",
      ),
    timeoutMs: z.number().int().min(1_000).max(120_000).default(60_000),
  }),
  output: z.object({
    ok: z.boolean(),
    url: z.string().describe("The page URL after submission settles."),
  }),
});

export type BrowserSubmitInput = z.output<typeof browserSubmit.input>;
export type BrowserSubmitOutput = z.output<typeof browserSubmit.output>;
