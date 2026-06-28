import { z } from "zod";
import { registerCapability } from "../registry";

// ── Browser automation ───────────────────────────────────────────────────────
// The `browser.*` capabilities drive a single live page inside a durable
// sandbox session (from agent.sandbox.start). State is SHARED across calls — a
// fill in one call persists to a submit in the next — because a long-running
// Playwright daemon (`browserd`) holds the page inside the same warm container.
// Every call is dispatched by running `browserctl` via agent.sandbox.exec, so
// the browser runs in the same sandbox as the app under test (localhost works).

export const browserNavigate = registerCapability({
  name: "browser.navigate",
  domain: "browser",
  description:
    "Navigate the durable sandbox's browser to a URL and wait for load. Use to prove a feature renders (e.g. http://localhost:3000/...).",
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
    sessionId: z
      .string()
      .min(1)
      .describe("Durable-session id (sbx_…) from agent.sandbox.start."),
    url: z.string().url().describe("Absolute URL to navigate to."),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(60_000)
      .describe("Navigation timeout in milliseconds."),
  }),
  output: z.object({
    url: z.string().describe("The final URL after any redirects."),
    title: z.string().describe("The document title after load."),
  }),
});

export type BrowserNavigateInput = z.output<typeof browserNavigate.input>;
export type BrowserNavigateOutput = z.output<typeof browserNavigate.output>;
