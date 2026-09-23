import { z } from "zod";
import { registerCapability } from "../registry";
import { avatarUrlOutputSchema } from "../avatar";
import { consequenceRolesSchema } from "../mandates/schemas";
import { steeringGatePolicy } from "./context.steering.freshness";

const workspaceSettingsOutput = z.object({
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  // Nullable avatar: an https:// URL or a designed-avatar spec string
  // ("avatar:v1:<json>"). Null when the workspace has no avatar set.
  avatarUrl: avatarUrlOutputSchema,
  // The effective consequence-role map (ADR-059 decision 1): every starter
  // tag plus the workspace's own, each with the org roles that may grant,
  // change or revoke a mandate for it. Overrides applied over the defaults.
  consequenceRoles: consequenceRolesSchema,
  // The two steering-freshness gates the workspace applies to every agent
  // its members run: pull `.oxagen/` forward by itself, and refuse a prompt
  // while it is behind the production branch. Both off by default. A
  // developer's local settings may switch one ON and can never switch one
  // OFF, so these are the floor for the workspace.
  steering: steeringGatePolicy,
  runEnrichmentEnabled: z.boolean().optional(),
});

export const workspaceSettingsRead = registerCapability({
  name: "get_workspace_settings",
  domain: "workspace",
  description:
    "Read the active workspace's general settings: name, slug, description, and the effective consequence-role map for mandates.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "workspace" },
  sensitivity: "low",
  mutates: false,
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
