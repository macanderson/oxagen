import { z } from "zod";
import { registerCapability } from "../registry";

// Full-replacement overrides for the curated-overridable content prompts.
// ENTERPRISE-gated at the handler (the core orchestration prompt is never
// overridable — only append-only via additionalInstructions).
const promptOverrides = z
  .object({
    "conversation.title": z.string().min(1).max(4000).optional(),
    "svg.generate": z.string().min(1).max(4000).optional(),
    "image.analyze": z.string().min(1).max(4000).optional(),
  })
  .partial();

export const promptSettingsWrite = registerCapability({
  name: "update_prompt_settings",
  domain: "workspace",
  description:
    "Update the workspace prompt configuration (partial). `additionalInstructions` and `autoImprovePrompts` are available on all plans; `overrides` (full prompt replacement) is enterprise-only.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "docs", "mcp", "unit"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "medium",
    category: "workspace",
  },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow" },
  },
  input: z.object({
    // omit = no change; null = clear; string = set.
    additionalInstructions: z.string().max(8000).nullable().optional(),
    // omit = no change; null = clear all overrides; object = replace the set.
    overrides: promptOverrides.nullable().optional(),
    autoImprovePrompts: z.boolean().optional(),
  }),
  output: z.object({
    additionalInstructions: z.string().nullable(),
    overrides: promptOverrides,
    autoImprovePrompts: z.boolean(),
  }),
});

export type PromptSettingsWriteInput = z.output<
  typeof promptSettingsWrite.input
>;
export type PromptSettingsWriteOutput = z.output<
  typeof promptSettingsWrite.output
>;
