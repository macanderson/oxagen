import { z } from "zod";
import { registerCapability } from "../registry";

// Read visible text from the durable sandbox browser's page (whole page or one
// element) for assertions — e.g. confirm a success banner's copy appeared.

export const browserRead = registerCapability({
  name: "read_page",
  domain: "browser",
  description:
    "Read visible text from the durable sandbox browser's current page (whole page, or a CSS-selected element) for assertions.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "browser" },
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
        "Optional CSS selector — read only that element's text instead of the page body.",
      ),
    timeoutMs: z.number().int().min(1_000).max(60_000).default(30_000),
  }),
  output: z.object({
    text: z.string().describe("Visible inner text (truncated to ~20k chars)."),
  }),
});

export type BrowserReadInput = z.output<typeof browserRead.input>;
export type BrowserReadOutput = z.output<typeof browserRead.output>;
