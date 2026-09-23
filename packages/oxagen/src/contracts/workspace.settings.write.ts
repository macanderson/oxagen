import { z } from "zod";
import { registerCapability } from "../registry";
import { workspaceSlug } from "../workspace-slug";
import { avatarUrlSchema, avatarUrlOutputSchema } from "../avatar";
import { consequenceRolesSchema } from "../mandates/schemas";
import {
  steeringGatePolicy,
  steeringGatePolicyPatch,
} from "./context.steering.freshness";

// Partial update of a workspace's general settings. Every field optional:
//   omit = unchanged, value = set, null = clear (description + avatar).
// `workspaceId` names a workspace of the org other than the one the call is
// scoped to — the Organization › Workspaces section edits from an org scope;
// omitted, the active workspace is the target.
export const workspaceSettingsWrite = registerCapability({
  name: "update_workspace_settings",
  domain: "workspace",
  description:
    "Update a workspace's general settings (partial): name, slug, description, and the consequence-role overrides for mandates. The active workspace unless workspaceId names another one in the organization. The handler checks roles: org Owners and Admins edit any workspace of the organization; the Owner or Admin of the workspace the call is scoped to edits that workspace only, without workspaceId. Only an org Owner writes consequenceRoles.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
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
    // The shared shape (packages/oxagen/src/workspace-slug.ts), the same one
    // `create_workspace` takes: a re-slug cannot move a workspace onto a
    // reserved org-route segment, and cannot be refused a bound the create
    // allowed (#3110).
    slug: workspaceSlug.optional(),
    description: z.string().max(2000).nullable().optional(),
    // Omit = unchanged, a value = set (https:// URL or an "avatar:v1:<json>"
    // designed-avatar string), null = clear the avatar. Models avatarUrl exactly
    // like org.settings.write (partial, nullable-to-clear).
    avatarUrl: avatarUrlSchema.nullable().optional(),
    // The consequence-role overrides (ADR-059 decision 1): tag → org roles.
    // Replaces the stored overrides as a whole; a tag left out falls back to
    // the defaults. Omit = unchanged.
    consequenceRoles: consequenceRolesSchema.optional(),
    // The two steering-freshness gates, as a patch: a member left out is
    // unchanged, so the UI can toggle one checkbox without resending the
    // other and racing a second editor. Omitting `steering` entirely leaves
    // both alone.
    steering: steeringGatePolicyPatch.optional(),
    runEnrichmentEnabled: z
      .boolean()
      .optional()
      .describe(
        "Generate run names and summaries with Stella using organization credits. Does not affect recorded evidence.",
      ),
  }),
  output: z.object({
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    avatarUrl: avatarUrlOutputSchema,
    consequenceRoles: consequenceRolesSchema,
    steering: steeringGatePolicy,
    runEnrichmentEnabled: z.boolean().optional(),
  }),
});

export type WorkspaceSettingsWriteInput = z.output<
  typeof workspaceSettingsWrite.input
>;
export type WorkspaceSettingsWriteOutput = z.output<
  typeof workspaceSettingsWrite.output
>;
