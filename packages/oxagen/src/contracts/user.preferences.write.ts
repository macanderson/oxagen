import { z } from "zod";
import { registerCapability } from "../registry";

export const userPreferencesWrite = registerCapability({
  name: "user.preferences.write",
  domain: "user",
  description:
    "Update the calling user's UI and model preferences (partial update — only provided fields are changed)",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "docs", "mcp", "unit", "app"],
  scoped: false,
  agent: { requiresApproval: false, riskLevel: "low", category: "user" },
  sensitivity: "low",
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
  input: z.object({
    fontSize: z.enum(["small", "medium", "large"]).optional(),
    density: z.enum(["compact", "comfortable", "spacious"]).optional(),
    enterToSubmit: z.boolean().optional(),
    pendingPromptBehavior: z.enum(["queue", "interrupt"]).optional(),
    // Nullable-optional: omit = no change; null = clear the pref; string = set
    defaultTextTier: z
      .enum(["fast", "balanced", "precise"])
      .nullable()
      .optional(),
    defaultTextModel: z.string().min(1).nullable().optional(),
    defaultImageModel: z.string().min(1).nullable().optional(),
    defaultVideoModel: z.string().min(1).nullable().optional(),
    // Account locale / regional settings
    timezone: z.string().min(1).optional(),
    language: z.string().min(2).optional(),
  }),
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

export type UserPreferencesWriteInput = z.output<
  typeof userPreferencesWrite.input
>;
export type UserPreferencesWriteOutput = z.output<
  typeof userPreferencesWrite.output
>;
