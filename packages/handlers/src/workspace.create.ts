// `create_workspace`: a workspace in the caller's org, and the start of its
// steering repo (steering-repo-spec, Provisioning; lane S1, #4450).
//
//   1. Role gate: assertOrgRole lets an org Owner or Admin in, or the Owner of
//      the workspace the call is scoped to (the contract's defaultRoles;
//      INV-29), for the signed-in user or the creator of the API key
//      (resolveActingUserId). The gate refuses a call with no acting user, so
//      the bootstrap below always has a creator.
//   2. The slug is unique in the org: the pre-check and the unique index's
//      23505 both read as `conflict` / `slug_taken`.
//   3. One transaction writes the workspace bootstrap and the first state of
//      its `steering_repo` setting.
//   4. The handler sends `steering-repo/provision.requested` and returns. The
//      durable job creates the private repository `oxagen-<slug>`, seeds it,
//      applies the prescribed settings, publishes version 1, and binds it with
//      role steering. It records each step in the setting, so the workspace
//      shows progress and a retry starts from the step that stopped.
//
// A workspace no longer takes a main repository. `mainRepo` is still accepted
// so older callers keep working, and it is ignored. Link a code repository
// afterwards with `link_repository`.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import {
  workspaceCreate,
  type WorkspaceCreateOutput,
} from "@oxagen/oxagen/contracts/workspace.create";
import { schema, withTenantDb, isUniqueViolation } from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import {
  initialSteeringRepoState,
  requestSteeringRepoProvision,
  settingsWithSteeringRepo,
  startSteeringRepoProvision,
  type SteeringRepoProvisionRequest,
} from "./steering_repo.provision";
import { bootstrapWorkspace } from "./workspace-bootstrap";

const slugTaken = (slug: string) =>
  new HandlerError({
    code: "conflict",
    reason: "slug_taken",
    message: `A workspace with the slug ${slug} already exists in this organization`,
  });

export interface WorkspaceCreateDeps {
  /** Start the job that provisions the workspace's steering repo. */
  requestProvision(data: SteeringRepoProvisionRequest): Promise<void>;
}

export function createWorkspaceCreateHandler(
  deps: WorkspaceCreateDeps,
): CapabilityHandler<typeof workspaceCreate> {
  return async (input, ctx): Promise<WorkspaceCreateOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"], workspace: ["Owner"] },
    );
    const userId = actingUserId as string;

    if (input.mainRepo !== undefined)
      logger.warn(
        { orgId: ctx.orgId, surface: ctx.surface },
        "workspace.create: mainRepo is ignored. A workspace gets a steering repo, and code repositories are linked afterwards.",
      );

    const tenant = await withTenantDb((tx) =>
      tx.query.organizations.findFirst({
        where: eq(schema.organizations.id, ctx.orgId),
        columns: { slug: true },
      }),
    );
    if (!tenant) {
      logger.warn({ orgId: ctx.orgId }, "workspace.create: tenant not found");
      throw new HandlerError({ code: "not_found", reason: "org_not_found" });
    }

    // (org_id, slug) uniqueness pre-checked for a typed refusal. The composite
    // unique index still enforces it as a hard constraint.
    const existing = await withTenantDb((tx) =>
      tx.query.workspaces.findFirst({
        where: and(
          eq(schema.workspaces.orgId, ctx.orgId),
          eq(schema.workspaces.slug, input.slug),
        ),
        columns: { id: true },
      }),
    );
    if (existing) {
      logger.warn(
        { orgId: ctx.orgId, slug: input.slug },
        "workspace.create: slug already in use (pre-check)",
      );
      throw slugTaken(input.slug);
    }

    const now = new Date();
    const state = initialSteeringRepoState(now);
    let ws: Awaited<ReturnType<typeof bootstrapWorkspace>>;
    try {
      ws = await withTenantDb(async (tx) => {
        // Re-points the transaction's workspace GUC at the new workspace, so
        // the settings write below passes its `tenant_isolation` check.
        const created = await bootstrapWorkspace({
          tx,
          orgId: ctx.orgId,
          userId,
          name: input.name,
          slug: input.slug,
        });
        await tx
          .update(schema.workspaces)
          .set({
            settings: settingsWithSteeringRepo(schema.workspaces.settings, state),
          })
          .where(eq(schema.workspaces.id, created.id));
        return created;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        logger.warn(
          { orgId: ctx.orgId, slug: input.slug },
          "workspace.create: slug conflict (race)",
        );
        throw slugTaken(input.slug);
      }
      logger.error(
        { err, orgId: ctx.orgId },
        "workspace.create: transaction failed",
      );
      throw err;
    }

    // The workspace exists whether or not the job starts. A job that could not
    // be queued is recorded as failed, so the workspace says so.
    const status = await startSteeringRepoProvision(
      { orgId: ctx.orgId, workspaceId: ws.id, actorUserId: userId },
      state,
      deps.requestProvision,
    );

    logger.info(
      {
        workspaceId: ws.id,
        orgId: ctx.orgId,
        slug: ws.slug,
        steeringRepo: status,
        surface: ctx.surface,
      },
      "workspace.create: workspace created, steering repo provisioning started",
    );

    // Record security event for workspace creation (privileged mutation).
    emitSecurityEventAsync({
      eventType: "workspace.created",
      actorUserId: userId,
      orgId: ctx.orgId,
      workspaceId: ws.id,
      outcome: "success",
      capability: null,
      ip: null,
      userAgent: null,
      requestId: ctx.requestId,
    }).catch((err: unknown) => {
      logger.error(
        { err, orgId: ctx.orgId, workspaceId: ws.id },
        "workspace.create: failed to record security event",
      );
    });

    return {
      publicId: ws.publicId,
      name: ws.name,
      slug: ws.slug,
      orgSlug: tenant.slug,
      createdAt: ws.createdAt.toISOString(),
      steering_repo: { status },
    };
  };
}

export const workspaceCreateHandler = createWorkspaceCreateHandler({
  requestProvision: requestSteeringRepoProvision,
});
