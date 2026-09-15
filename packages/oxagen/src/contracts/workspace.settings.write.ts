import { z } from "zod";
import { registerCapability } from "../registry";
import { avatarUrlSchema, avatarUrlOutputSchema } from "../avatar";

// Partial update of a workspace's general settings. Every field optional:
//   omit = unchanged, value = set, null = clear (description + avatar).
// `workspaceId` names a workspace of the org other than the one the call is
// scoped to — the Organization › Workspaces section edits from an org scope;
// omitted, the active workspace is the target.
export const workspaceSettingsWrite = registerCapability({
  name: "update_workspace_settings",
  domain: "workspace",
  description:
    "Update a workspace's general settings (partial): name, slug, and description. The active workspace unless workspaceId names another one in the organization. The handler checks roles: org Owners and Admins edit any workspace of the organization; the Owner or Admin of the workspace the call is scoped to edits that workspace only, without workspaceId.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  // A settings write, never a governed action (ADR-052 exclusion 2; INV-28).
  noBillingGate: true,
  agent: {
    requiresApproval: false,
    riskLevel: "medium",
    category: "workspace",
  },
  sensitivity: "medium",
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow" },
  },
  input: z.object({
    workspaceId: z
      .string()
      .startsWith("wrk_")
      .optional()
      .describe(
        "Public id (wrk_…) of the workspace to update; omitted, the workspace the call is scoped to",
      ),
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
