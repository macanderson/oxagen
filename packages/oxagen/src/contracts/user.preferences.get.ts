import { z } from "zod";
import { registerCapability } from "../registry";

export const userPreferencesGet = registerCapability({
  name: "user.preferences.get",
  domain: "user",
  description: "Get the calling user's display preferences (theme, language, timezone, notification settings)",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp"],
  scoped: false,
  agent: { requiresApproval: false, riskLevel: "low", category: "user" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow", Viewer: "allow" },
    workspace: { Owner: "allow", Admin: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({}),
  output: z.object({
    theme: z.string(),
    language: z.string(),
    timezone: z.string(),
    notification_settings: z.record(z.unknown()),
  }),
});

export type UserPreferencesGetInput = z.output<typeof userPreferencesGet.input>;
export type UserPreferencesGetOutput = z.output<typeof userPreferencesGet.output>;
