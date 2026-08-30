import { z } from "zod";
import { registerCapability } from "../registry";
import { avatarUrlOutputSchema } from "../avatar";

const workspaceSettingsOutput = z.object({
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  // Nullable avatar: an https:// URL or a designed-avatar spec string
  // ("avatar:v1:<json>"). Null when the workspace has no avatar set.
  avatarUrl: avatarUrlOutputSchema,
});

export const workspaceSettingsRead = registerCapability({
  name: "get_workspace_settings",
  domain: "workspace",
  description:
    "Read the active workspace's general settings: name, slug, and description.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "workspace" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Admin: "allow", Member: "allow" },
  },
  input: z.object({}),
  output: workspaceSettingsOutput,
});

export type WorkspaceSettingsReadOutput = z.output<
  typeof workspaceSettingsRead.output
>;
