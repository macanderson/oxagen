"use server";
/**
 * agent-prefs-actions.ts — server action backing the agent picker's
 * "default assistant" star. Sets the calling user's per-workspace default agent
 * via `update_workspace_user_preferences`.
 *
 * Mirrors conversation-actions.ts: resolves org + workspace from slugs, asserts
 * membership (the IDOR guard, since apps/app's invoke() skips the IAM kernel —
 * see CLAUDE.md "apps/app does not bootstrap IAM"), then dispatches through the
 * single kernel `invoke()` chokepoint so metering + audit run on every write.
 */
import { invoke } from "@oxagen/oxagen";
// Side-effect import: bind every handler into the kernel so invoke() can resolve
// the workspace-preferences write handler. Without it invoke() throws
// "No handler registered".
import "@oxagen/handlers/register";
import { userWorkspacePreferencesWrite } from "@oxagen/oxagen/contracts/user.workspace_preferences.write";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";

/** Slug context the client carries from the URL; org/workspace ids resolve server-side. */
export interface AgentPrefsActionCtx {
  orgSlug: string;
  workspaceSlug: string;
}

/**
 * Set (or clear, when `agentId` is null) the calling user's default agent for
 * this workspace. Returns `{ ok }` so the client's optimistic star can revert
 * on failure.
 */
export async function setDefaultAgentAction(
  ctx: AgentPrefsActionCtx,
  agentId: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = userWorkspacePreferencesWrite.input.safeParse({
    defaultAgentId: agentId,
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid default agent",
    };
  }
  try {
    const session = await getSessionOrRedirect();
    const org = await resolveOrg(ctx.orgSlug);
    const ws = await resolveWorkspace(org.id, ctx.workspaceSlug);
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
    // OMIT opts.surface: the contract's surfaces are ["api"] only (the web app
    // is the sole writer), and apps/app is a trusted server caller — passing a
    // surface would trip the kernel's surface gate (surface_denied).
    await invoke(
      userWorkspacePreferencesWrite.name,
      parsed.data,
      capabilityCtx,
    );
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to set default agent",
    };
  }
}
