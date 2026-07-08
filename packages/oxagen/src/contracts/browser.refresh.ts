import { z } from "zod";
import { registerCapability } from "../registry";

// Reload the durable sandbox browser's current page.

export const browserRefresh = registerCapability({
  name: "refresh_page",
  aliases: ["browser.refresh"],
  domain: "browser",
  description:
    "Reload the durable sandbox browser's current page and wait for load. Useful after a rebuild/HMR to re-check a feature.",
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
    timeoutMs: z.number().int().min(1_000).max(120_000).default(60_000),
  }),
  output: z.object({
    ok: z.boolean(),
    url: z.string().describe("The page URL after reload."),
  }),
});

export type BrowserRefreshInput = z.output<typeof browserRefresh.input>;
export type BrowserRefreshOutput = z.output<typeof browserRefresh.output>;
