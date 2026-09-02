"use server";
/**
 * member-actions.ts — server actions for org member management.
 *
 * Two mutations:
 *   removeMemberAction  — invokes org.member.remove
 *   changeMemberRoleAction — invokes org.member.role.change
 *
 * Both route through the kernel invoke() chokepoint so metering, IAM, and
 * audit run on every call. The handler enforces Owner/Admin role; the server
 * action only builds the capability context and delegates.
 *
 * Pattern mirrors apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/models/models-action.ts:
 *   1. getSessionOrRedirect() to assert auth.
 *   2. resolveOrg() to get the org UUID (slug→id).
 *   3. assertOrgMember() to confirm the caller is in the org (IDOR guard before
 *      reaching invoke — the handler does its own role gate).
 *   4. Build capability context with crypto.randomUUID() requestId.
 *   5. invoke() with surface "agent".
 *   6. revalidatePath() on success.
 */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, assertOrgMember } from "@/lib/resolve-org";
import { invoke } from "@oxagen/oxagen";
// Side-effect import: bind all handlers into the kernel so invoke() can resolve
// org.member.remove and org.member.role.change at runtime.
import "@oxagen/handlers/register";

// Sentinel workspaceId for org-only actions (no workspace context). Both
// capabilities below are `scoped: true`, so the kernel enters
// runInTenantScope() with this context — and runInTenantScope fail-closes on
// any non-uuid, so an empty string here throws TenantScopeError before the
// handler ever runs. Matches the sentinel used by actions.ts / page.tsx /
// layout.tsx in this directory.
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

// ── Input schemas ─────────────────────────────────────────────────────────────

const RemoveMemberSchema = z.object({
  orgSlug: z.string().min(1),
  targetUserId: z.string().min(1),
});

const ChangeRoleSchema = z.object({
  orgSlug: z.string().min(1),
  targetUserId: z.string().min(1),
  newRole: z.string().min(1),
});

// ── Result types ──────────────────────────────────────────────────────────────

export type MemberActionResult = { ok: true } | { ok: false; error: string };

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildCtx(opts: { orgId: string; userId: string }) {
  return {
    orgId: opts.orgId,
    workspaceId: ORG_ONLY_WS, // org-level action — sentinel workspace scope
    userId: opts.userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };
}

// ── removeMemberAction ────────────────────────────────────────────────────────

export async function removeMemberAction(
  input: z.infer<typeof RemoveMemberSchema>,
): Promise<MemberActionResult> {
  const session = await getSessionOrRedirect();

  const parsed = RemoveMemberSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid input" };
  }

  const { orgSlug, targetUserId } = parsed.data;
  const org = await resolveOrg(orgSlug);

  // Assert caller is an org member before hitting the capability (IDOR pre-check).
  // The capability handler enforces Owner/Admin role gate.
  await assertOrgMember(org.id, session.user.id);

  const ctx = buildCtx({ orgId: org.id, userId: session.user.id });

  try {
    await invoke("remove_org_member", { targetUserId }, ctx, {
      surface: "agent",
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to remove member";
    return { ok: false, error: message };
  }

  revalidatePath(`/${orgSlug}/members`);
  return { ok: true };
}

// ── changeMemberRoleAction ────────────────────────────────────────────────────

export async function changeMemberRoleAction(
  input: z.infer<typeof ChangeRoleSchema>,
): Promise<MemberActionResult> {
  const session = await getSessionOrRedirect();

  const parsed = ChangeRoleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid input" };
  }

  const { orgSlug, targetUserId, newRole } = parsed.data;
  const org = await resolveOrg(orgSlug);

  await assertOrgMember(org.id, session.user.id);

  const ctx = buildCtx({ orgId: org.id, userId: session.user.id });

  try {
    await invoke("change_member_role", { targetUserId, newRole }, ctx, {
      surface: "agent",
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to change role";
    return { ok: false, error: message };
  }

  revalidatePath(`/${orgSlug}/members`);
  return { ok: true };
}
