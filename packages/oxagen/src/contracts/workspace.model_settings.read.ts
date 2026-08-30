import { z } from "zod";
import { registerCapability } from "../registry";

export const workspaceModelSettingsRead = registerCapability({
  name: "get_model_settings",
  domain: "workspace",
  description:
    "Read the workspace-level model defaults (text tier/model, image model, video model)",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "docs", "mcp", "unit", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "workspace" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow", Member: "allow" },
  },
  input: z.object({}),
  output: z.object({
    defaultTextTier: z.enum(["fast", "balanced", "precise"]).nullable(),
    defaultTextModel: z.string().nullable(),
    defaultImageModel: z.string().nullable(),
    defaultVideoModel: z.string().nullable(),
  }),
});

export type WorkspaceModelSettingsReadInput = z.output<
  typeof workspaceModelSettingsRead.input
>;
export type WorkspaceModelSettingsReadOutput = z.output<
  typeof workspaceModelSettingsRead.output
>;
