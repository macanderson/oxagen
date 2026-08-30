import { z } from "zod";
import { registerCapability } from "../registry";

// Overrides are keyed by the curated-overridable prompt keys (content prompts).
// Mirrors OVERRIDABLE_PROMPT_KEYS in @oxagen/ai's prompt registry.
const promptOverrides = z
  .object({
    "conversation.title": z.string().optional(),
    "svg.generate": z.string().optional(),
    "image.analyze": z.string().optional(),
  })
  .partial();

export const promptSettingsRead = registerCapability({
  name: "get_prompt_settings",
  domain: "workspace",
  description:
    "Read the workspace prompt configuration: appended instructions, content-prompt overrides, and the auto-improve-prompts toggle.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "docs", "mcp", "unit"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "workspace" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Admin: "allow", Member: "allow" },
  },
  input: z.object({}),
  output: z.object({
    additionalInstructions: z.string().nullable(),
    overrides: promptOverrides,
    autoImprovePrompts: z.boolean(),
  }),
});

export type PromptSettingsReadOutput = z.output<
  typeof promptSettingsRead.output
>;
