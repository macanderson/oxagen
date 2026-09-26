// audit-exempt: workspace-profile field edit (name/slug/description) — no fitting security-event type exists in the taxonomy (no workspace.settings_updated); covered by the kernel capability.invoke_* audit. Do not invent a type.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { workspaceSettingsWrite } from "@oxagen/oxagen/contracts/workspace.settings.write";
import { schema, withTenantDb, isUniqueViolation } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { getPrincipalAttribution, runInTenantScope } from "@oxagen/tenancy";
import { and, eq, sql } from "drizzle-orm";
import { mapWorkspaceSettingsRow } from "./workspace.settings.read";
import { logger } from "./logger";

// Postgres unique_violation (SQLSTATE 23505) — workspaces_org_slug_idx fires
// when a slug is already taken by another workspace in the same org. Use the
// shared classifier: drizzle wraps the driver error, so the SQLSTATE lives on
// `.cause` and a top-level-only `err.code` check would miss every real
// violation and leak the raw `Failed query: update …` SQL to the caller.

const workspaceNotFound = () =>
  new HandlerError({ code: "not_found", reason: "workspace_not_found" });

/**
 * `archive_workspace` promises the archived workspace's slug "stays taken"
 * (packages/handlers/src/workspace.archive.ts step 4), and the redirect from
 * its old slugs in `workspace.workspace_slug_history` rests on that. Editing
 * an archived workspace's slug breaks both: the `(org_id, slug)` unique index
 * releases the old value, a new workspace takes it, and a direct slug match
 * beats the archived workspace's history redirect — so a link to the archived
 * workspace silently lands somewhere else. An archived workspace has left the
 * switcher and is a record; it is not edited. Refused the same way a second
 * archive is.
 */
const workspaceArchived = (name: string, archivedAt: Date) =>
  new HandlerError({
    code: "conflict",
    reason: "workspace_archived",
    message: `${name} was archived on ${archivedAt.toISOString()}; an archived workspace's settings cannot be changed`,
  });

// Partial update of workspace.workspaces for the workspace `input.workspaceId`
// names in the org, or the active one. name, slug, avatarUrl and description
// are all real columns, each set independently — so a concurrent
// prompt.settings.write can no longer clobber description (audit §1.7).
//
//   1. Role gate — assertOrgRole (INV-29), for the signed-in user or the
//      creator of the API key (resolveActingUserId). With no `workspaceId` the target is
//      the scoped workspace: org Owner or Admin, or that workspace's Owner or
//      Admin (the contract's defaultRoles). With a `workspaceId` the gate
//      accepts org Owner or Admin only, because `assertOrgRole` reads the
//      workspace role on `ctx.workspaceId` and a workspace role must not
//      reach another workspace of the org.
//   2. `consequenceRoles` decides who may grant a mandate over money and the
//      other consequences (ADR-059 decision 1), so writing it also needs the
//      org Owner.
//   3. The target is resolved by public id in the org (`not_found`), an
//      archived one is refused (`conflict`, `workspace_archived`), the slug
//      rename is captured and the unique index's 23505 reads as
//      `conflict` / `slug_taken`.
//   4. The resolve runs in whatever scope the caller is in — `workspace.workspaces`
//      is `org_only`, so it reads under an org-only scope (ADR-068). The write
//      block does NOT: `workspace.workspace_slug_history` is a `standard` table
//      (tenant-policy.manifest.ts), so its RLS `WITH CHECK` compares the row's
//      `workspace_id` against `app.current_workspace_id`. Reached from an
//      org-only scope — the app's `/{org}` Workspaces section (#2964), the API's
//      org-only mount — that GUC holds `ORG_ONLY_WORKSPACE_ID`, the slug-history
//      INSERT raises 42501, and because that is not a unique violation it escapes
//      the classifier below and surfaces as a 500. So the update and the history
//      capture re-enter the TARGET workspace's scope, the way `workspace.archive`
//      does for `agent.agents`.
export const workspaceSettingsWriteHandler: CapabilityHandler<
  typeof workspaceSettingsWrite
> = async (input, ctx) => {
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    input.workspaceId === undefined
      ? { org: ["Owner", "Admin"], workspace: ["Owner", "Admin"] }
      : { org: ["Owner", "Admin"] },
  );
  if (input.consequenceRoles !== undefined) {
    await assertOrgRole({ ...ctx, userId: actingUserId }, { org: ["Owner"] });
  }

  // `workspace.workspaces` is org_only, so the target resolves under an
  // org-only scope as well as a workspace one.
  const target = await withTenantDb((tx) =>
    tx.query.workspaces.findFirst({
      where: input.workspaceId
        ? and(
            eq(schema.workspaces.orgId, ctx.orgId),
            eq(schema.workspaces.publicId, input.workspaceId),
          )
        : and(
            eq(schema.workspaces.orgId, ctx.orgId),
            eq(schema.workspaces.id, ctx.workspaceId),
          ),
      columns: {
        id: true,
        name: true,
        slug: true,
        avatarUrl: true,
        description: true,
        consequenceRoles: true,
        // Carried so the no-op path can still report the steering gates.
        settings: true,
        archivedAt: true,
      },
    }),
  );

  if (!target) {
    logger.warn(
      { orgId: ctx.orgId, workspaceId: input.workspaceId ?? ctx.workspaceId },
      "workspace.settings.write: workspace not found",
    );
    throw workspaceNotFound();
  }
  if (target.archivedAt !== null) {
    logger.warn(
      { orgId: ctx.orgId, workspaceId: input.workspaceId ?? ctx.workspaceId },
      "workspace.settings.write: workspace is archived",
    );
    throw workspaceArchived(target.name, target.archivedAt);
  }
  const { id: workspaceId, archivedAt: _archivedAt, ...existing } = target;

  const row = await runInTenantScope(
    {
      ...getPrincipalAttribution(),
      orgId: ctx.orgId,
      // The write touches a workspace-GUC-scoped table, so it runs in the
      // target workspace's scope and never in the org-only sentinel's.
      workspaceId,
    },
    () =>
      withTenantDb(async (tx) => {
        const updates: Record<string, unknown> = {};
        if (input.name !== undefined) updates.name = input.name;
        if (input.slug !== undefined) updates.slug = input.slug;
        // avatarUrl is a real column: null clears, a string sets, undefined leaves it.
        if (input.avatarUrl !== undefined) updates.avatarUrl = input.avatarUrl;
        // description is now a real column too: null clears, a string sets.
        if (input.description !== undefined)
          updates.description = input.description;
        // The consequence-role overrides replace as a whole (ADR-059 decision 1).
        if (input.consequenceRoles !== undefined)
          updates.consequenceRoles = input.consequenceRoles;
        // The two steering-freshness gates live in the shared `settings`
        // JSONB bag, so they MERGE rather than replace, twice over:
        // `jsonb ||` at the top level keeps whatever else the bag holds, and
        // the nested `||` keeps the gate this call did not name. A plain set
        // here would silently clear every other key in the bag, which is
        // exactly the clobber that moved `description` and `promptConfig`
        // out into columns of their own (audit §1.7).
        //
        // Both sides of that merge are guarded on `jsonb_typeof(...) =
        // 'object'` rather than on COALESCE, because COALESCE answers SQL
        // NULL and neither of these values is one. A bag holding JSON `null`,
        // and a `steering` key holding JSON `null`, a string or an array, all
        // pass COALESCE untouched, and `jsonb ||` combines a non-object with
        // the patch as an ARRAY. Measured on Postgres 16, the old expression
        // turned `{"steering": null}` into `{"steering": [null, {...}]}` and
        // a bag of JSON `null` into a top-level array. `readGatePolicy`
        // (context.steering.freshness.ts) then fails to parse the block and
        // reports both freshness gates off, and this capability is the only
        // surface that could repair it, so one malformed value disabled both
        // gates permanently. Normalising a non-object to `{}` makes the write
        // the repair path it was always meant to be: the checkbox fixes the
        // block instead of re-merging into it.
        if (input.steering !== undefined) {
          const bag = sql`CASE WHEN jsonb_typeof(${schema.workspaces.settings}) = 'object' THEN ${schema.workspaces.settings} ELSE '{}'::jsonb END`;
          const block = sql`CASE WHEN jsonb_typeof(${schema.workspaces.settings} -> 'steering') = 'object' THEN ${schema.workspaces.settings} -> 'steering' ELSE '{}'::jsonb END`;
          updates.settings = sql`
            ${bag}
            || jsonb_build_object(
                 'steering',
                 ${block} || ${JSON.stringify(input.steering)}::jsonb
               )`;
        }

        if (input.runEnrichmentEnabled !== undefined) {
          const bag =
            updates.settings ??
            sql`CASE WHEN jsonb_typeof(${schema.workspaces.settings}) = 'object' THEN ${schema.workspaces.settings} ELSE '{}'::jsonb END`;
          updates.settings = sql`${bag} || ${JSON.stringify({ runEnrichmentEnabled: input.runEnrichmentEnabled })}::jsonb`;
        }
        if (Object.keys(updates).length === 0) {
          return existing;
        }

        // Slug-rename capture must precede the UPDATE so a unique-violation throw
        // rolls back the history insert with the rest of the transaction (no
        // dangling history rows pointing at slugs the rename never actually
        // produced).
        const slugChanged =
          input.slug !== undefined && input.slug !== existing.slug;

        try {
          if (slugChanged && input.slug !== undefined) {
            await tx.insert(schema.workspaceSlugHistory).values({
              orgId: ctx.orgId,
              workspaceId,
              oldSlug: existing.slug,
              newSlug: input.slug,
            });
          }
          await tx
            .update(schema.workspaces)
            .set({ ...updates, updatedAt: new Date() })
            .where(eq(schema.workspaces.id, workspaceId));
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new HandlerError({
              code: "conflict",
              reason: "slug_taken",
              message: `A workspace with the slug ${input.slug} already exists in this organization`,
            });
          }
          throw err;
        }

        // Turning run enrichment back on writes no run row (#3784). A run
        // the workspace recorded while it was off was never summarized, or
        // changed after its last account, so the sweep already finds it due.
        // Resetting every run here held row locks across the workspace's
        // whole history inside this request.
        return tx.query.workspaces.findFirst({
          where: eq(schema.workspaces.id, workspaceId),
          columns: {
            name: true,
            slug: true,
            avatarUrl: true,
            description: true,
            consequenceRoles: true,
            settings: true,
          },
        });
      }),
  );

  if (!row) {
    logger.warn(
      { orgId: ctx.orgId, workspaceId: input.workspaceId ?? ctx.workspaceId },
      "workspace.settings.write: workspace not found",
    );
    throw workspaceNotFound();
  }

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: input.workspaceId ?? ctx.workspaceId,
      surface: ctx.surface,
    },
    "workspace.settings.write: updated workspace settings",
  );
  return mapWorkspaceSettingsRow(row);
};
