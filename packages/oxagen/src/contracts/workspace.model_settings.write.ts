import { z } from "zod";
import { registerCapability } from "../registry";

export const workspaceModelSettingsWrite = registerCapability({
  name: "update_model_settings",
  domain: "workspace",
  description:
    "Update the workspace-level model defaults (partial update — only provided fields are changed)",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "docs", "mcp", "unit", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "workspace" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow" },
  },
  input: z.object({
    // Nullable-optional: omit = no change; null = clear the setting; string = set
    defaultTextTier: z
      .enum(["fast", "balanced", "precise"])
      .nullable()
      .optional(),
    defaultTextModel: z.string().min(1).nullable().optional(),
    defaultImageModel: z.string().min(1).nullable().optional(),
    defaultVideoModel: z.string().min(1).nullable().optional(),
  }),
  output: z.object({
    defaultTextTier: z.enum(["fast", "balanced", "precise"]).nullable(),
    defaultTextModel: z.string().nullable(),
    defaultImageModel: z.string().nullable(),
    defaultVideoModel: z.string().nullable(),
  }),
});

export type WorkspaceModelSettingsWriteInput = z.output<
  typeof workspaceModelSettingsWrite.input
>;
export type WorkspaceModelSettingsWriteOutput = z.output<
  typeof workspaceModelSettingsWrite.output
>;
