import { z } from "zod";
import { defineTool } from "./_define";
import { userPreferencesWrite } from "../user.preferences.write";
import { userPreferencesRead } from "../user.preferences.read";
import { userWorkspacePreferencesWrite } from "../user.workspace_preferences.write";
import { userWorkspacePreferencesRead } from "../user.workspace_preferences.read";
import { pluginSettingsSetAuthAlerts } from "../plugin.settings.set_auth_alerts";

/**
 * Appendix E: `set_preferences`. Absorbs `update_user_preferences`,
 * `get_user_preferences`, `update_workspace_user_preferences`,
 * `get_workspace_user_preferences` and `set_auth_alerts`.
 *
 * **The reads fold in as the return value.** Appendix E's drop list ends with
 * "reads folded into the objects above", and this is that pattern at its
 * simplest: a partial write that answers with the full resolved state. The two
 * `get_` contracts contribute their output shapes verbatim, which is why
 * nothing of theirs is in `drops` — their empty inputs have no fields to lose.
 *
 * **Three scopes, so three groups.** Account preferences are per user and cross
 * every workspace; the coding-agent defaults are per user *per workspace*; the
 * auth-alert setting is per organization and is the only one of the three that
 * is not the caller's own. Flattening them into one object would hide that the
 * third has a different blast radius and a different audience, and it is the
 * reason for the grades below.
 *
 * **The cost of the fold.** `set_auth_alerts` is org-governed: medium
 * sensitivity, approval required, Owner and Admin only. Those are the strictest
 * values among the five and they carry to the whole tool, so on the seed grants
 * a workspace Member cannot set their own font size. That is not a good
 * outcome, and it is the one thing a reviewer should check here: either the
 * org-alert branch needs its own governed action, or the approval rule has to
 * key on the argument path (§6.9 keys rules on the canonical action, which
 * makes `authAlerts` present a condition a policy can match). The contract's
 * static grade cannot be anything but the ceiling of its branches.
 */
export const setPreferences = defineTool({
  name: "set_preferences",
  domain: "assistant",
  description:
    "Set and read the caller's account preferences, their per-workspace coding-agent defaults, and the organization's MCP auth-alert setting. Partial: only the groups and fields provided are changed, and the full resolved state is returned.",
  mode: "sync",
  /**
   * API only, carried from `update_workspace_user_preferences`, whose own note
   * is explicit: "the default repo/environment preference is set exclusively in
   * the web app. MCP/agent surfaces read it but must not silently rewrite a
   * user's default." That reason holds at least as strongly for the account
   * group — an agent quietly changing the operator's default model tier is a
   * routing change nobody asked for (§4.5). The UI reaches this through the
   * API; §14.1's CLI list does not include preferences.
   */
  surfaces: ["api"],
  layers: ["schema", "api", "docs", "unit"],
  // `update_user_preferences` is unscoped (account-level); the other four are
  // workspace- or org-scoped. Scoped carries: two of the three groups cannot be
  // resolved without a workspace.
  scoped: true,

  absorbs: [
    "update_user_preferences",
    "get_user_preferences",
    "update_workspace_user_preferences",
    "get_workspace_user_preferences",
    "set_auth_alerts",
  ],
  drops: [
    {
      field: "defaultEnvironmentId",
      from: "update_workspace_user_preferences",
      why: "Appendix E drops the whole `environment.*` family — 'no runtime' in v1. A default pointing at an object no product surface can create or list is a preference that can only ever dangle.",
    },
    {
      field: "defaultEnvironmentId (output)",
      from: "get_workspace_user_preferences",
      why: "follows the input — same family, same reason",
    },
    {
      field: "defaultRepoSlug",
      from: "update_workspace_user_preferences",
      why: "the input side only — denormalized `owner/repo` text for display, derived from `defaultRepoConnectionId`. Letting a caller set it independently is how the two drift; it is still returned on this tool's `workspace` output, resolved server-side from the connection.",
    },
    {
      field: "output { ok }",
      from: "set_auth_alerts",
      why: "a bare boolean cannot serve as the read side, and the read side is the point of this fold. Replaced by the resolved `authAlerts` object, carried off the same field definitions.",
    },
  ],

  /**
   * `set_auth_alerts` requires approval and grades medium; the other four are
   * low with no approval. The strictest carries — see the note above about what
   * that costs. `category` is not a strictness axis, so it names this tool's
   * job rather than `set_auth_alerts`' `plugin`.
   */
  agent: { requiresApproval: true, riskLevel: "medium", category: "user" },
  sensitivity: "medium",
  defaultEffect: "deny",
  /**
   * The preference contracts grant Owner, Admin, Member and Viewer at both
   * scopes; `set_auth_alerts` grants org Owner and Admin and nothing at
   * workspace scope. The stricter map carries. This is the grade a reviewer
   * should push back on first.
   */
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  mutates: true,

  input: z.object({
    /**
     * Per user, across every workspace. Omit the group to leave it untouched;
     * within it, omitting a field means no change and an explicit `null` on the
     * nullable fields clears the preference — the three-way distinction the
     * source encodes as nullable-optional, carried by reference so it survives.
     */
    account: z
      .object({
        fontSize: userPreferencesWrite.input.shape.fontSize,
        density: userPreferencesWrite.input.shape.density,
        enterToSubmit: userPreferencesWrite.input.shape.enterToSubmit,
        pendingPromptBehavior:
          userPreferencesWrite.input.shape.pendingPromptBehavior,
        /** §4.5's tiers. Null clears it and falls back to workspace routing. */
        defaultTextTier: userPreferencesWrite.input.shape.defaultTextTier,
        defaultTextModel: userPreferencesWrite.input.shape.defaultTextModel,
        timezone: userPreferencesWrite.input.shape.timezone,
        language: userPreferencesWrite.input.shape.language,
      })
      .optional(),

    /** Per user, per workspace: the defaults a coding task starts from. */
    workspace: z
      .object({
        defaultRepoConnectionId:
          userWorkspacePreferencesWrite.input.shape.defaultRepoConnectionId,
        /** The `agt_` public id; null clears it and the app picks. */
        defaultAgentId:
          userWorkspacePreferencesWrite.input.shape.defaultAgentId,
        /**
         * Stamps `repo_default_prompted_at` so the one-time "set a default
         * repo?" prompt is not offered again — dismissing a prompt is a write,
         * and this is the field that records it.
         */
        markRepoPrompted:
          userWorkspacePreferencesWrite.input.shape.markRepoPrompted,
      })
      .optional(),

    /**
     * Organization scope, not the caller's own — the group whose grade sets the
     * whole tool's. Default when unset is `{ sendEmail: true, roles: ["Owner",
     * "Admin"] }`.
     */
    authAlerts: z
      .object({
        sendEmail: pluginSettingsSetAuthAlerts.input.shape.sendEmail,
        /** Non-empty subset of the org roles. Alerts nobody receives are not alerts. */
        roles: pluginSettingsSetAuthAlerts.input.shape.roles,
      })
      .optional(),
  }),

  /**
   * The full resolved state of all three groups, which is what the two absorbed
   * `get_` contracts returned. Every account and workspace field is carried
   * from the read contract rather than the write one, so the read side stays
   * the authority on what a resolved preference looks like.
   */
  output: z.object({
    account: z.object({
      fontSize: userPreferencesRead.output.shape.fontSize,
      density: userPreferencesRead.output.shape.density,
      enterToSubmit: userPreferencesRead.output.shape.enterToSubmit,
      pendingPromptBehavior:
        userPreferencesRead.output.shape.pendingPromptBehavior,
      defaultTextTier: userPreferencesRead.output.shape.defaultTextTier,
      defaultTextModel: userPreferencesRead.output.shape.defaultTextModel,
      timezone: userPreferencesRead.output.shape.timezone,
      language: userPreferencesRead.output.shape.language,
    }),

    workspace: z.object({
      defaultRepoConnectionId:
        userWorkspacePreferencesRead.output.shape.defaultRepoConnectionId,
      /** Resolved server-side from the connection — see the drop on the input side. */
      defaultRepoSlug:
        userWorkspacePreferencesRead.output.shape.defaultRepoSlug,
      defaultAgentId: userWorkspacePreferencesRead.output.shape.defaultAgentId,
      /** False means never prompted, so the app should offer the prompt. */
      repoDefaultPrompted:
        userWorkspacePreferencesRead.output.shape.repoDefaultPrompted,
    }),

    /**
     * `set_auth_alerts` had no read side — its output was `{ ok }` and the read
     * lived on `get_auth_alerts`, which Appendix E gives to `query_audit_log`.
     * The resolved setting is described with the same field definitions as the
     * input, because a setting's read and write shapes are the same shape.
     */
    authAlerts: z.object({
      sendEmail: pluginSettingsSetAuthAlerts.input.shape.sendEmail,
      roles: pluginSettingsSetAuthAlerts.input.shape.roles,
    }),
  }),
});

export type SetPreferencesInput = z.output<typeof setPreferences.input>;
export type SetPreferencesOutput = z.output<typeof setPreferences.output>;
