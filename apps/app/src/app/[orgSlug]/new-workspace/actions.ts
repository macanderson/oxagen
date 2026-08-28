"use server";
import { and, eq } from "drizzle-orm";
import {
  withTenantDb,
  withSystemDb,
  schema,
  isUniqueViolation,
  deriveNamespace,
} from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import { logger } from "@oxagen/handlers/logger";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, assertOrgMember } from "@/lib/resolve-org";
import { bootstrapWorkspaceAgents } from "@oxagen/handlers/workspace-agents";
import { seedWorkspaceDefaultRegistrySystem } from "@oxagen/handlers/workspace-registry-seed";
import { seedWorkspaceDefaultCapabilitiesSystem } from "@oxagen/handlers/workspace-capability-seed";
import { seedWorkspaceDefaultSkillsSystem } from "@oxagen/handlers/skill-workspace-seed";
import { seedWorkspaceDefaultEnvironmentSystem } from "@oxagen/handlers/workspace-environment-seed";

// Mirrors the workspace.create capability's defaultRoles (org Owner/Admin allow).
// Re-checked server-side here so the gate can't be bypassed from the client.
const WORKSPACE_CREATE_ROLES = new Set(["owner", "admin"]);

// Slugs that collide with static [orgSlug] child routes — a workspace with one
// of these slugs would be shadowed by the route and unreachable. "new-workspace"
// is this very page; "settings" is the org settings subtree.
const RESERVED_WORKSPACE_SLUGS = new Set(["new-workspace", "settings"]);

// Sentinel workspaceId for org-only scope (workspace does not exist yet at
// pre-check time; withTenantDb sets both GUCs but org_only-classed tables
// only evaluate the org_id GUC)
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

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

  return await runInTenantScope(
    { orgId: org.id, workspaceId: ORG_ONLY_WS },
    async () => {
      // Authorization: only org owners/admins may create workspaces.
      const [membership] = await withTenantDb((tx) =>
        tx
          .select({ role: schema.orgUsers.role })
          .from(schema.orgUsers)
          .where(
            and(
              eq(schema.orgUsers.orgId, org.id),
              eq(schema.orgUsers.userId, session.user.id),
            ),
          )
          .limit(1),
      );
      if (
        !membership ||
        !WORKSPACE_CREATE_ROLES.has(membership.role.toLowerCase())
      ) {
        return {
          ok: false,
          error: "Only organization owners and admins can create workspaces",
        };
      }

      const parsed = workspaceCreate.input.safeParse({
        name: formData.get("name"),
        slug: formData.get("slug"),
      });
      if (!parsed.success) {
        return {
          ok: false,
          error: parsed.error.issues[0]?.message ?? "Invalid workspace",
        };
      }
      if (RESERVED_WORKSPACE_SLUGS.has(parsed.data.slug)) {
        return {
          ok: false,
          error: `"${parsed.data.slug}" is a reserved slug — choose another`,
        };
      }

      // Pre-check slug uniqueness for a friendly error; the composite unique index
      // is the hard guard that handles the concurrent-create race below.
      const existing = await withTenantDb((tx) =>
        tx
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(
            and(
              eq(schema.workspaces.orgId, org.id),
              eq(schema.workspaces.slug, parsed.data.slug),
            ),
          )
          .limit(1),
      );
      if (existing[0]) {
        return {
          ok: false,
          error: `Slug "${parsed.data.slug}" is already taken in this organization`,
        };
      }

      try {
        // tenancy: unscoped seam for workspace + membership creation. The
        // workspace_only RLS policy on workspace_users checks WITH CHECK
        // (workspace_id = current_setting('app.workspace_id')::uuid). When the
        // scope is set to the sentinel (ORG_ONLY_WS) and the INSERT carries the
        // real new workspace id, Postgres rejects the write. Using withSystemDb
        // (RLS bypass) for this bootstrap creation is the correct fix — the
        // workspace and its creator's membership row ARE the objects being
        // created, so there is no prior scope to derive from.
        const { workspaceId, workspaceSlug } = await withSystemDb(
          async (tx) => {
            // Derive the immutable namespace, unique within this (existing) org.
            // The (org_id, namespace) unique index is the hard race guard.
            const takenNamespaces = new Set(
              (
                await tx
                  .select({ namespace: schema.workspaces.namespace })
                  .from(schema.workspaces)
                  .where(eq(schema.workspaces.orgId, org.id))
              ).map((r) => r.namespace.toLowerCase()),
            );
            const namespace = deriveNamespace(
              parsed.data.slug,
              takenNamespaces,
            );

            const [ws] = await tx
              .insert(schema.workspaces)
              .values({
                orgId: org.id,
                name: parsed.data.name,
                slug: parsed.data.slug,
                namespace,
                createdByUserId: session.user.id,
                updatedByUserId: session.user.id,
              })
              .returning({
                id: schema.workspaces.id,
                slug: schema.workspaces.slug,
              });
            if (!ws) throw new Error("Workspace insert returned no row");

            await tx.insert(schema.workspaceUsers).values({
              workspaceId: ws.id,
              userId: session.user.id,
              role: "owner",
              joinedAt: new Date(),
              createdByUserId: session.user.id,
              updatedByUserId: session.user.id,
            });

            // Bootstrap the built-in qa-chat agent atomically with workspace creation
            // so the workspace is immediately usable from the ask/chat surface.
            await bootstrapWorkspaceAgents({
              workspaceId: ws.id,
              orgId: org.id,
              userId: session.user.id,
              tx,
            });

            return { workspaceId: ws.id, workspaceSlug: ws.slug };
          },
        );

        // Seed the default MCP registry, capability packs, and builtin skills
        // outside the transaction (fire-and-log): a seed failure must NOT roll
        // back the workspace that was just created.
        try {
          await seedWorkspaceDefaultRegistrySystem({
            orgId: org.id,
            workspaceId,
          });
        } catch (seedErr) {
          logger.error(
            { err: seedErr, orgId: org.id, workspaceId },
            "[new-workspace] seedWorkspaceDefaultRegistrySystem failed — workspace was created; seed is recoverable via db:backfill-workspace-seeds",
          );
        }
        try {
          await seedWorkspaceDefaultCapabilitiesSystem({
            orgId: org.id,
            workspaceId,
          });
        } catch (seedErr) {
          logger.error(
            { err: seedErr, orgId: org.id, workspaceId },
            "[new-workspace] seedWorkspaceDefaultCapabilitiesSystem failed — workspace was created; seed is recoverable via db:backfill-workspace-seeds",
          );
        }
        try {
          await seedWorkspaceDefaultSkillsSystem({
            orgId: org.id,
            workspaceId,
          });
        } catch (seedErr) {
          logger.error(
            { err: seedErr, orgId: org.id, workspaceId },
            "[new-workspace] seedWorkspaceDefaultSkillsSystem failed — workspace was created; seed is recoverable via db:backfill-workspace-seeds",
          );
        }
        try {
          await seedWorkspaceDefaultEnvironmentSystem({
            orgId: org.id,
            workspaceId,
          });
        } catch (seedErr) {
          logger.error(
            { err: seedErr, orgId: org.id, workspaceId },
            "[new-workspace] seedWorkspaceDefaultEnvironmentSystem failed — workspace was created; seed is recoverable via db:backfill-workspace-seeds",
          );
        }

        return { ok: true, workspaceSlug };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return {
            ok: false,
            error: `Slug "${parsed.data.slug}" is already taken in this organization`,
          };
        }
        // Never surface a raw driver/SQL error to the user (information leak); log
        // for diagnosis and return a generic, safe message.
        logger.error(
          { err, orgId: org.id, slug: parsed.data.slug },
          "[new-workspace] createWorkspaceAction failed",
        );
        return {
          ok: false,
          error: "Failed to create workspace. Please try again.",
        };
      }
    },
  );
}
