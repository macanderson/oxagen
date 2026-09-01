import { z } from "zod";
import { registerCapability } from "../registry";

// ── Cross-LLM proof-of-done ──────────────────────────────────────────────────
// `agent.feature.verify` closes the loop on "is the feature actually built?".
// A code agent drives the durable-sandbox browser, captures screenshots of the
// success state (browser.screenshot → private asset keys), then calls this with
// the original requirement. An INDEPENDENT vision model — deliberately chosen
// from a DIFFERENT vendor than the builder — reads the actual pixels and returns
// a structured verdict. The judge never sees the builder's reasoning, only the
// requirement and the screenshots, so a feature that merely *claims* to work but
// doesn't render is caught here, not shipped.

export const agentFeatureVerify = registerCapability({
  name: "verify_feature",
  domain: "agent",
  description:
    "Independent cross-LLM judge: a DIFFERENT vision model than the builder reads screenshots of a feature and returns a pass/fail verdict against the stated requirement. The proof-of-done gate.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "verification" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    requirement: z
      .string()
      .min(1)
      .max(8000)
      .describe("What the feature is supposed to do / show — the spec the judge holds the screenshots against."),
    screenshotKeys: z
      .array(z.string().min(1))
      .min(1)
      .max(8)
      .describe("Private asset keys from browser.screenshot — the images the judge reads."),
    builderModel: z
      .string()
      .optional()
      .describe(
        "Gateway model id of the agent that built the feature (e.g. 'anthropic/claude-opus-4.8'). " +
          "The judge is forced to a DIFFERENT vendor so the verdict is independent.",
      ),
    checklist: z
      .array(z.string().min(1))
      .max(20)
      .optional()
      .describe("Optional explicit things the judge must confirm are visible/working in the screenshots."),
  }),
  output: z.object({
    verdict: z
      .enum(["pass", "fail", "inconclusive"])
      .describe("'pass' only when the screenshots clearly satisfy the requirement."),
    confidence: z.number().min(0).max(1),
    judgeModel: z.string().describe("The independent model that rendered the verdict."),
    builderModel: z.string().nullable().describe("The builder model excluded from judging, if provided."),
    observations: z.array(z.string()).describe("What the judge actually saw in the screenshots."),
    issues: z.array(z.string()).describe("Missing/broken elements blocking a pass."),
    reasoning: z.string().describe("The judge's justification for the verdict."),
  }),
});

export type AgentFeatureVerifyInput = z.output<typeof agentFeatureVerify.input>;
export type AgentFeatureVerifyOutput = z.output<typeof agentFeatureVerify.output>;
