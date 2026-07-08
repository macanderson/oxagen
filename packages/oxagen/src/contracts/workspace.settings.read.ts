import { z } from "zod";
import { registerCapability } from "../registry";

const workspaceSettingsOutput = z.object({
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
});

export const workspaceSettingsRead = registerCapability({
  name: "workspace.settings.read",
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

export type WorkspaceSettingsReadOutput = z.output<typeof workspaceSettingsRead.output>;
