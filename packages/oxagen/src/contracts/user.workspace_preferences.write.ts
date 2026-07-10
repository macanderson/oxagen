import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * Update the calling user's per-workspace coding-agent defaults (partial update
 * — only provided fields change). Workspace-scoped. This is the ONLY surface
 * that may write these defaults: the web app. Setting a default repo also lets
 * the caller record the one-time prompt as answered via `markRepoPrompted`.
 */
export const userWorkspacePreferencesWrite = registerCapability({
  name: "update_workspace_user_preferences",
  domain: "user",
  description:
    "Update the calling user's per-workspace coding-agent defaults (partial update): default repository connection + its owner/repo slug, default environment, default agent, and whether the one-time repo-default prompt has been answered. App-only surface for setting a preferred/default repo, environment, and agent for coding tasks.",
  mode: "sync",
  // App-only per the product requirement: the default repo/environment
  // preference is set exclusively in the web app. MCP/agent surfaces read it
  // but must not silently rewrite a user's default.
  surfaces: ["api"],
  layers: ["schema", "api", "docs", "unit", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "user" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow", Viewer: "allow" },
    workspace: {
      Owner: "allow",
      Admin: "allow",
      Member: "allow",
      Viewer: "allow",
    },
  },
  input: z.object({
    // Nullable-optional: omit = no change; null = clear the default; string = set.
    defaultRepoConnectionId: z.string().min(1).nullable().optional(),
    defaultRepoSlug: z.string().min(1).nullable().optional(),
    defaultEnvironmentId: z.string().min(1).nullable().optional(),
    // Nullable-optional: omit = no change; null = clear the default agent;
    // string = set it (the agents.public_id, agt_…).
    defaultAgentId: z.string().min(1).nullable().optional(),
    // When true, stamps repo_default_prompted_at=now() so the one-time prompt is
    // not shown again (e.g. the user dismissed it or just set a default).
    markRepoPrompted: z.boolean().optional(),
  }),
  output: z.object({
    defaultRepoConnectionId: z.string().nullable(),
    defaultRepoSlug: z.string().nullable(),
    defaultEnvironmentId: z.string().nullable(),
    defaultAgentId: z.string().nullable(),
    repoDefaultPrompted: z.boolean(),
  }),
});

export type UserWorkspacePreferencesWriteInput = z.output<
  typeof userWorkspacePreferencesWrite.input
>;
export type UserWorkspacePreferencesWriteOutput = z.output<
  typeof userWorkspacePreferencesWrite.output
>;
