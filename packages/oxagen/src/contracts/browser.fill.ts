import { z } from "zod";
import { registerCapability } from "../registry";

// Fill a form field on the durable sandbox browser's live page. State persists,
// so a later browser.submit acts on the value set here.

export const browserFill = registerCapability({
  name: "fill_page",
  domain: "browser",
  description:
    "Fill a form field (by CSS selector) on the durable sandbox browser's current page. Playwright auto-waits for the element.",
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
      .describe("CSS selector for the input/textarea/select."),
    value: z.string().describe("Value to set (empty string clears the field)."),
    timeoutMs: z.number().int().min(1_000).max(60_000).default(30_000),
  }),
  output: z.object({ ok: z.boolean() }),
});

export type BrowserFillInput = z.output<typeof browserFill.input>;
export type BrowserFillOutput = z.output<typeof browserFill.output>;
