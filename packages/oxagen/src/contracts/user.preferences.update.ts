import { z } from "zod";
import { registerCapability } from "../registry";

export const userPreferencesUpdate = registerCapability({
  name: "user.preferences.update",
  domain: "user",
  description: "Update the calling user's display preferences (theme, language, timezone) — partial update",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp"],
  scoped: false,
  agent: { requiresApproval: false, riskLevel: "low", category: "user" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow", Viewer: "allow" },
    workspace: { Owner: "allow", Admin: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({
    theme: z.string().optional(),
    language: z.string().optional(),
    timezone: z.string().optional(),
  }),
  output: z.object({
    theme: z.string(),
    language: z.string(),
    timezone: z.string(),
    notification_settings: z.record(z.unknown()),
  }),
});

export type UserPreferencesUpdateInput = z.output<typeof userPreferencesUpdate.input>;
export type UserPreferencesUpdateOutput = z.output<typeof userPreferencesUpdate.output>;
