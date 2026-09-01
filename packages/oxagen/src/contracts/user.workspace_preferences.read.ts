import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * Read the calling user's per-workspace coding-agent defaults: their preferred
 * default repository (connection + resolved owner/repo slug), default
 * environment, default agent, and whether the one-time "set a default repo?"
 * prompt has been shown yet. Workspace-scoped (each workspace has its own
 * defaults for a user).
 */
export const userWorkspacePreferencesRead = registerCapability({
  name: "get_workspace_user_preferences",
  domain: "user",
  description:
    "Read the calling user's per-workspace coding-agent defaults: preferred default repository connection and its owner/repo slug, default environment, default agent, and whether the one-time repo-default prompt has been shown. Readable by all members so the app can pre-select the user's default repo/environment/agent and decide whether to offer the first-time prompt.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "docs", "mcp", "unit", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "user" },
  sensitivity: "low",
  mutates: false,
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
  input: z.object({}),
  output: z.object({
    /** Preferred default repo connection publicId (con_…); null = no default set. */
    defaultRepoConnectionId: z.string().nullable(),
    /** Denormalized owner/repo slug of the default connection, for display; null when unset. */
    defaultRepoSlug: z.string().nullable(),
    /** Preferred default environment publicId (env_…); null = use the workspace default. */
    defaultEnvironmentId: z.string().nullable(),
    /** Preferred default agent publicId (agt_…); null = no default → app uses its built-in selection. */
    defaultAgentId: z.string().nullable(),
    /**
     * Whether the one-time repo-default prompt has been shown/answered. false =
     * never prompted → the app surface should offer it on first repo-selector open.
     */
    repoDefaultPrompted: z.boolean(),
  }),
});

export type UserWorkspacePreferencesReadInput = z.output<
  typeof userWorkspacePreferencesRead.input
>;
export type UserWorkspacePreferencesReadOutput = z.output<
  typeof userWorkspacePreferencesRead.output
>;
