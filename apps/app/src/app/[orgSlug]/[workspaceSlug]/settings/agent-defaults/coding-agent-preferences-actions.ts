"use server";
/**
 * coding-agent-preferences-actions.ts — server action backing the "Your
 * coding-agent preferences" section on Workspace → Settings → Agent Defaults
 * → Models sub-tab.
 *
 * Writes the calling user's FULL per-user default (repo + environment +
 * agent) through `update_workspace_user_preferences` — see
 * coding-agent-preferences-form.tsx. The agent picker's "default assistant"
 * star (`_shared/agent-prefs-actions.ts::setDefaultAgentAction`) writes just
 * `defaultAgentId` through the same capability.
 *
 * The READ side is NOT duplicated here: `get_workspace_user_preferences` is
 * invoked directly from page.tsx alongside the other three sub-tabs' reads
 * (get_model_settings / get_budget_policy / get_prompt_settings), reusing the
 * page's single resolved org/workspace/session context.
 *
 * Write surfaces are ["api"] ONLY (app-only capability — the web app is the
 * sole writer of a user's coding-agent defaults) → invoke() WITHOUT a
 * `surface` override, same as
 * ../../_shared/agent-prefs-actions.ts::setDefaultAgentAction.
 *
 * No workspace-role gate: the contract's `defaultRoles` allow every workspace
 * role (Owner/Admin/Member/Viewer) — these are the CALLING USER's own
 * personal defaults, not workspace governance, so only org membership is
 * asserted (the IDOR guard) before invoking.
 */
import { z } from "zod";
import { invoke } from "@oxagen/oxagen";
// Side-effect import: bind every foundation handler so invoke() can resolve.
import "@oxagen/handlers/register";
import { userWorkspacePreferencesWrite } from "@oxagen/oxagen/contracts/user.workspace_preferences.write";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";

// ── Input schema ─────────────────────────────────────────────────────────────

const UpdateCodingAgentPreferencesSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  // Nullable: null clears the saved default; a string sets it.
  defaultRepoConnectionId: z.string().min(1).nullable(),
  defaultRepoSlug: z.string().min(1).nullable(),
  defaultEnvironmentId: z.string().min(1).nullable(),
  defaultAgentId: z.string().min(1).nullable(),
});

export type UpdateCodingAgentPreferencesInput = z.infer<
  typeof UpdateCodingAgentPreferencesSchema
>;

export type UpdateCodingAgentPreferencesResult =
  | { ok: true }
  | { ok: false; error: string };

// ── Action ────────────────────────────────────────────────────────────────────

export async function updateCodingAgentPreferencesAction(
  input: UpdateCodingAgentPreferencesInput,
): Promise<UpdateCodingAgentPreferencesResult> {
  const parsed = UpdateCodingAgentPreferencesSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const {
    orgSlug,
    workspaceSlug,
    defaultRepoConnectionId,
    defaultRepoSlug,
    defaultEnvironmentId,
    defaultAgentId,
  } = parsed.data;

  try {
    const session = await getSessionOrRedirect();
    // Resolve org + workspace — notFound() on slug mismatch prevents cross-tenant writes.
    const org = await resolveOrg(orgSlug);
    const ws = await resolveWorkspace(org.id, workspaceSlug);
    // Assert the caller is an org member (IDOR guard) — no workspace-role gate,
    // these are the caller's own personal defaults (see file header).
    await assertOrgMember(org.id, session.user.id);

    const capabilityCtx = {
      orgId: org.id,
      workspaceId: ws.id,
      userId: session.user.id,
      apiKeyId: null as string | null,
      requestId: crypto.randomUUID(),
      surface: "app" as const,
      messageId: null as string | null,
    };

    // OMIT opts.surface: the write contract's surfaces are ["api"] only (the
    // web app is the sole writer) — passing a surface would trip the
    // kernel's surface gate (surface_denied).
    await invoke(
      userWorkspacePreferencesWrite.name,
      {
        defaultRepoConnectionId,
        defaultRepoSlug,
        defaultEnvironmentId,
        defaultAgentId,
      },
      capabilityCtx,
    );
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "Failed to save coding-agent preferences.",
    };
  }
}
