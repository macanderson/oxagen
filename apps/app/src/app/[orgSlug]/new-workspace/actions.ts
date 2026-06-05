"use server";
import { and, eq } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, assertOrgMember } from "@/lib/resolve-org";

// Mirrors the workspace.create capability's defaultRoles (org Owner/Admin allow).
// Re-checked server-side here so the gate can't be bypassed from the client.
const WORKSPACE_CREATE_ROLES = new Set(["owner", "admin"]);

// Slugs that collide with static [orgSlug] child routes — a workspace with one
// of these slugs would be shadowed by the route and unreachable. "new-workspace"
// is this very page; "settings" is the org settings subtree.
const RESERVED_WORKSPACE_SLUGS = new Set(["new-workspace", "settings"]);

/** Postgres unique_violation — the (org_id, slug) index lost a create race. */
function isSlugConflict(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/**
 * Create a workspace inside the active org. `orgSlug` is bound in the page so
 * the client form passes only the FormData. Validates against the shared
 * workspace.create contract (same input schema the API/MCP enforce), gates on
 * org owner/admin, and seeds the creator as the workspace owner — the same
 * shape as workspaceCreateHandler, kept as a thin app action to match the
 * new-organization precedent (no kernel context plumbing in a server action).
 */
export async function createWorkspaceAction(
  orgSlug: string,
  formData: FormData,
): Promise<{ ok: true; workspaceSlug: string } | { ok: false; error: string }> {
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  await assertOrgMember(org.id, session.user.id);

  // Authorization: only org owners/admins may create workspaces.
  const [membership] = await db()
    .select({ role: schema.orgUsers.role })
    .from(schema.orgUsers)
    .where(and(eq(schema.orgUsers.orgId, org.id), eq(schema.orgUsers.userId, session.user.id)))
    .limit(1);
  if (!membership || !WORKSPACE_CREATE_ROLES.has(membership.role.toLowerCase())) {
    return { ok: false, error: "Only organization owners and admins can create workspaces" };
  }

  const parsed = workspaceCreate.input.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid workspace" };
  }
  if (RESERVED_WORKSPACE_SLUGS.has(parsed.data.slug)) {
    return { ok: false, error: `"${parsed.data.slug}" is a reserved slug — choose another` };
  }

  // Pre-check slug uniqueness for a friendly error; the composite unique index
  // is the hard guard that handles the concurrent-create race below.
  const existing = await db()
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.orgId, org.id), eq(schema.workspaces.slug, parsed.data.slug)))
    .limit(1);
  if (existing[0]) {
    return { ok: false, error: `Slug "${parsed.data.slug}" is already taken in this organization` };
  }

  try {
    const workspaceSlug = await db().transaction(async (tx) => {
      const [ws] = await tx
        .insert(schema.workspaces)
        .values({
          orgId: org.id,
          name: parsed.data.name,
          slug: parsed.data.slug,
          createdByUserId: session.user.id,
          updatedByUserId: session.user.id,
        })
        .returning({ id: schema.workspaces.id, slug: schema.workspaces.slug });
      if (!ws) throw new Error("Workspace insert returned no row");

      await tx.insert(schema.workspaceUsers).values({
        workspaceId: ws.id,
        userId: session.user.id,
        role: "owner",
        joinedAt: new Date(),
        createdByUserId: session.user.id,
        updatedByUserId: session.user.id,
      });
      return ws.slug;
    });
    return { ok: true, workspaceSlug };
  } catch (err) {
    if (isSlugConflict(err)) {
      return { ok: false, error: `Slug "${parsed.data.slug}" is already taken in this organization` };
    }
    return { ok: false, error: err instanceof Error ? err.message : "Failed to create workspace" };
  }
}
