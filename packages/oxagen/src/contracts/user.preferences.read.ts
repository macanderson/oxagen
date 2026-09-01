import { z } from "zod";
import { registerCapability } from "../registry";

export const userPreferencesRead = registerCapability({
  name: "get_user_preferences",
  domain: "user",
  description: "Read the calling user's UI and model preferences",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "docs", "mcp", "unit"],
  scoped: false,
  agent: { requiresApproval: false, riskLevel: "low", category: "user" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow", Viewer: "allow" },
    workspace: {
      Owner: "allow",
      Admin: "allow",
      Member: "allow",
      Viewer: "allow",
    },
  },
  input: z.object({}),
  output: z.object({
    fontSize: z.enum(["small", "medium", "large"]),
    density: z.enum(["compact", "comfortable", "spacious"]),
    enterToSubmit: z.boolean(),
    pendingPromptBehavior: z.enum(["queue", "interrupt"]),
    defaultTextTier: z.enum(["fast", "balanced", "precise"]).nullable(),
    defaultTextModel: z.string().nullable(),
    defaultImageModel: z.string().nullable(),
    defaultVideoModel: z.string().nullable(),
    timezone: z.string(),
    language: z.string(),
  }),
});

export type UserPreferencesReadInput = z.output<
  typeof userPreferencesRead.input
>;
export type UserPreferencesReadOutput = z.output<
  typeof userPreferencesRead.output
>;
