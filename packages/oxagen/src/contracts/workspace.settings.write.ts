import { z } from "zod";
import { registerCapability } from "../registry";
import { avatarUrlSchema, avatarUrlOutputSchema } from "../avatar";

// Partial update of the workspace general settings. Every field optional:
//   omit = unchanged, value = set, null = clear (description + avatar).
export const workspaceSettingsWrite = registerCapability({
  name: "update_workspace_settings",
  domain: "workspace",
  description:
    "Update the active workspace's general settings (partial): name, slug, and description. Routes the workspace settings edit through the kernel so the same fields are reachable from the agent, MCP, and CLI with metering + audit.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
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
    name: z.string().min(1).max(120).trim().optional(),
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Slug must be lowercase letters, numbers, and single hyphens",
      )
      .optional(),
    description: z.string().max(2000).nullable().optional(),
    // Omit = unchanged, a value = set (https:// URL or an "avatar:v1:<json>"
    // designed-avatar string), null = clear the avatar. Models avatarUrl exactly
    // like org.settings.write (partial, nullable-to-clear).
    avatarUrl: avatarUrlSchema.nullable().optional(),
  }),
  output: z.object({
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    avatarUrl: avatarUrlOutputSchema,
  }),
});

export type WorkspaceSettingsWriteInput = z.output<
  typeof workspaceSettingsWrite.input
>;
export type WorkspaceSettingsWriteOutput = z.output<
  typeof workspaceSettingsWrite.output
>;
