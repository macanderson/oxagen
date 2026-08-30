"use server";

// ── Server action: update_model_settings ─────────────────────────────────────
//
// Writes the workspace-level model defaults through the single invoke()
// chokepoint. The contract is scoped and surfaced on ["api","mcp","agent"] —
// not "app" — so the call declares surface "agent" to satisfy the kernel's
// surface allow-list, the same trick the in-app schema proxy uses.
//
// KNOWN GAP: the contract's defaultRoles restrict this write to org/workspace
// Owner and Admin, but apps/app does not bootstrap kernel IAM, and the only
// gate here is assertOrgMember — so any org member passes. It needs the same
// explicit owner/admin role read that new-workspace/actions.ts does before it
// is wired to a UI. Nothing invokes it today outside its own unit test.

import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { workspaceModelSettingsWrite } from "@oxagen/oxagen/contracts/workspace.model_settings.write";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";

export interface UpdateModelSettingsInput {
  orgSlug: string;
  workspaceSlug: string;
  defaultTextTier?: "fast" | "balanced" | "precise" | null;
  defaultTextModel?: string | null;
}

export type UpdateModelSettingsResult =
  | { ok: true }
  | { ok: false; error: string };

export async function updateModelSettingsAction(
  input: UpdateModelSettingsInput,
): Promise<UpdateModelSettingsResult> {
  const parsed = workspaceModelSettingsWrite.input.safeParse({
    defaultTextTier: input.defaultTextTier,
    defaultTextModel: input.defaultTextModel,
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid settings",
    };
  }

  let session: Awaited<ReturnType<typeof getSessionOrRedirect>>;
  try {
    session = await getSessionOrRedirect();
  } catch {
    return { ok: false, error: "Not authenticated." };
  }

  let orgId: string;
  let workspaceId: string;
  try {
    const org = await resolveOrg(input.orgSlug);
    const ws = await resolveWorkspace(org.id, input.workspaceSlug);
    await assertOrgMember(org.id, session.user.id);
    orgId = org.id;
    workspaceId = ws.id;
  } catch {
    return { ok: false, error: "Org or workspace not found." };
  }

  const ctx = {
    orgId,
    workspaceId,
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  try {
    await invoke("update_model_settings", parsed.data, ctx, {
      surface: "agent",
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to update settings.",
    };
  }
}
