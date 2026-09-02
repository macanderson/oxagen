import { z } from "zod";
import { registerCapability } from "../registry";

// Capture the durable sandbox browser's current page (or one element) as a PNG,
// store it as a PRIVATE workspace blob, and return its key — the input that
// agent.feature.verify (the cross-LLM judge) reads to confirm the feature works.

export const browserScreenshot = registerCapability({
  name: "screenshot_page",
  domain: "browser",
  description:
    "Screenshot the durable sandbox browser's current page (or a CSS-selected element) and store it as a private workspace asset. Returns the asset key/url for the cross-LLM judge.",
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
        "Optional CSS selector — screenshot only that element instead of the page.",
      ),
    fullPage: z
      .boolean()
      .default(false)
      .describe(
        "Capture the full scrollable page rather than just the viewport.",
      ),
    timeoutMs: z.number().int().min(1_000).max(120_000).default(60_000),
  }),
  output: z.object({
    key: z
      .string()
      .describe("Private storage key — pass to agent.feature.verify."),
    url: z
      .string()
      .describe("Storage URL (private; bytes served via authenticated read)."),
    width: z.number().int(),
    height: z.number().int(),
    bytes: z.number().int().describe("PNG byte length."),
  }),
});

export type BrowserScreenshotInput = z.output<typeof browserScreenshot.input>;
export type BrowserScreenshotOutput = z.output<typeof browserScreenshot.output>;
