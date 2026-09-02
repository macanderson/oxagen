import { z } from "zod";
import { registerCapability } from "../registry";

// Click an element (by CSS selector) on the durable sandbox browser's page.

export const browserClick = registerCapability({
  name: "click_page",
  domain: "browser",
  description:
    "Click an element (by CSS selector) on the durable sandbox browser's current page. Playwright auto-waits for the element to be actionable.",
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
      .describe("CSS selector of the element to click."),
    timeoutMs: z.number().int().min(1_000).max(120_000).default(60_000),
  }),
  output: z.object({
    ok: z.boolean(),
    url: z.string().describe("The page URL after the click settles."),
  }),
});

export type BrowserClickInput = z.output<typeof browserClick.input>;
export type BrowserClickOutput = z.output<typeof browserClick.output>;
